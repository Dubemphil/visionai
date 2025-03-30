const { Storage } = require('@google-cloud/storage');
const { google } = require('googleapis');
const vision = require('@google-cloud/vision');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;
const storage = new Storage();
const visionClient = new vision.ImageAnnotatorClient();
sheets = google.sheets('v4');
drive = google.drive('v3');

app.use(session({ secret: 'your_secret', resave: false, saveUninitialized: true }));
app.use(passport.initialize());
app.use(passport.session());

console.log("Using Redirect URI:", process.env.GOOGLE_REDIRECT_URI);

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_REDIRECT_URI || "http://localhost:8080/auth/callback"
}, (accessToken, refreshToken, profile, done) => {
    if (!accessToken) {
        console.error("OAuth Error: Missing Access Token");
        return done(new Error("OAuth authentication failed"), null);
    }
    console.log("OAuth Success - Access Token:", accessToken);
    profile.accessToken = accessToken;
    return done(null, profile);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.get('/auth', (req, res, next) => {
    passport.authenticate('google', { 
        scope: [
            'profile',
            'email',
            'https://www.googleapis.com/auth/drive',
            'https://www.googleapis.com/auth/spreadsheets'
        ]
    })(req, res, next);
});

app.get('/auth/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => {
    if (!req.user) {
        console.error("Authentication failed - No user profile returned");
        return res.status(401).json({ error: "Authentication failed" });
    }
    req.session.accessToken = req.user.accessToken;
    console.log("Stored accessToken in session:", req.session.accessToken);
    res.redirect('/select-folder');
});

async function listFolders(auth) {
    try {
        const driveService = google.drive({ version: 'v3', auth });
        const response = await driveService.files.list({
            q: "mimeType='application/vnd.google-apps.folder'",
            fields: 'files(id, name)'
        });
        return response.data.files;
    } catch (error) {
        console.error("Error fetching folders:", error);
        return [];
    }
}

app.get('/select-folder', async (req, res) => {
    try {
        if (!req.session.accessToken) {
            return res.status(401).json({ error: "Unauthorized - Missing Access Token" });
        }
        const auth = new google.auth.OAuth2();
        auth.setCredentials({ access_token: req.session.accessToken });

        const folders = await listFolders(auth);
        
        let html = '<h1>Select a Folder</h1><ul>';
        folders.forEach(folder => {
            html += `<li><a href="/process-folder?folderId=${folder.id}">${folder.name}</a></li>`;
        });
        html += '</ul>';
        res.send(html);
    } catch (error) {
        console.error("Error selecting folder:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

async function listImagesInFolder(auth, folderId) {
    try {
        const driveService = google.drive({ version: 'v3', auth });
        const response = await driveService.files.list({
            q: `'${folderId}' in parents and mimeType contains 'image/'`,
            fields: 'files(id, name)'
        });
        return response.data.files;
    } catch (error) {
        console.error("Error fetching images:", error);
        return [];
    }
}

async function extractBarcodesFromImages(auth, images) {
    const extractedLinks = [];
    for (const image of images) {
        const [result] = await visionClient.textDetection(`https://drive.google.com/uc?id=${image.id}`);
        const detections = result.textAnnotations;
        if (detections.length > 0) {
            extractedLinks.push([detections[0].description]);
        }
    }
    return extractedLinks;
}

async function getExistingSpreadsheet(auth, folderId) {
    const driveService = google.drive({ version: 'v3', auth });
    const response = await driveService.files.list({
        q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet'`,
        fields: 'files(id, name)',
    });
    return response.data.files.length > 0 ? response.data.files[0].id : null;
}

app.get('/process-folder', async (req, res) => {
    try {
        const folderId = req.query.folderId;
        if (!folderId) {
            return res.redirect('/select-folder');
        }

        if (!req.session.accessToken) {
            return res.status(401).json({ error: "Unauthorized - Missing Access Token" });
        }

        const auth = new google.auth.OAuth2();
        auth.setCredentials({ access_token: req.session.accessToken });

        let spreadsheetId = await getExistingSpreadsheet(auth, folderId);
        if (!spreadsheetId) {
            spreadsheetId = await createSpreadsheetInFolder(auth, folderId);
            if (!spreadsheetId) {
                return res.status(500).json({ error: "Failed to create spreadsheet" });
            }
        }

        const images = await listImagesInFolder(auth, folderId);
        const extractedLinks = await extractBarcodesFromImages(auth, images);

        if (extractedLinks.length > 0) {
            await sheets.spreadsheets.values.update({
                auth,
                spreadsheetId,
                range: "Sheet1!A2",
                valueInputOption: "RAW",
                resource: { values: extractedLinks }
            });
        }

        res.json({ message: `Processing folder: ${folderId}`, spreadsheetId });
    } catch (error) {
        console.error("Error processing folder:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/', (req, res) => {
    res.json({ message: "Google Drive Scraper is running!" });
});

app.listen(port, () => {
    console.log(`✅ Server running on http://localhost:${port}`);
});
