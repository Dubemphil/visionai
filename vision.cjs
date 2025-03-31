const { Storage } = require('@google-cloud/storage');
const { google } = require('googleapis');
const vision = require('@google-cloud/vision');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;
const visionClient = new vision.ImageAnnotatorClient();
const sheets = google.sheets('v4');
const drive = google.drive('v3');

app.use(session({ secret: 'your_secret', resave: false, saveUninitialized: true }));
app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_REDIRECT_URI || "http://localhost:8080/auth/callback"
}, (accessToken, refreshToken, profile, done) => {
    profile.accessToken = accessToken;
    return done(null, profile);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.get('/auth', passport.authenticate('google', { 
    scope: ['profile', 'email', 'https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets']
}));

app.get('/auth/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => {
    req.session.accessToken = req.user.accessToken;
    res.redirect('/select-folder');
});

async function listFolders(auth) {
    const driveService = google.drive({ version: 'v3', auth });
    const response = await driveService.files.list({
        q: "mimeType='application/vnd.google-apps.folder'",
        fields: 'files(id, name)'
    });
    return response.data.files;
}

async function listImagesInFolder(auth, folderId) {
    const driveService = google.drive({ version: 'v3', auth });
    const response = await driveService.files.list({
        q: `'${folderId}' in parents and mimeType contains 'image/'`,
        fields: 'files(id, name, webContentLink)'
    });
    return response.data.files;
}

async function scanBarcodesFromImages(images) {
    let extractedLinks = [];
    for (let image of images) {
        try {
            const [result] = await visionClient.textDetection(image.webContentLink);
            const detections = result.textAnnotations;
            if (detections.length > 0) {
                extractedLinks.push(detections[0].description.trim());
            }
        } catch (error) {
            console.error(`Error scanning barcode in image ${image.name}:`, error);
        }
    }
    return extractedLinks;
}

async function createSpreadsheetInFolder(auth, folderId, folderName) {
    const driveService = google.drive({ version: 'v3', auth });
    const response = await driveService.files.create({
        resource: { name: folderName, mimeType: 'application/vnd.google-apps.spreadsheet' },
        fields: 'id, parents'
    });
    const spreadsheetId = response.data.id;
    await driveService.files.update({
        fileId: spreadsheetId,
        addParents: folderId,
        removeParents: response.data.parents ? response.data.parents.join(',') : '',
        fields: 'id, parents'
    });
    return spreadsheetId;
}

async function updateSheet(auth, spreadsheetId, links) {
    const sheetsService = google.sheets({ version: 'v4', auth });
    await sheetsService.spreadsheets.values.update({
        spreadsheetId,
        range: 'Sheet1!A2:A',
        valueInputOption: 'RAW',
        resource: { values: links.map(link => [link]) }
    });
}

app.get('/select-folder', async (req, res) => {
    if (!req.session.accessToken) return res.status(401).json({ error: "Unauthorized" });
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: req.session.accessToken });
    const folders = await listFolders(auth);
    let html = '<h1>Select a Folder</h1><ul>';
    folders.forEach(folder => {
        html += `<li><a href="/process-folder?folderId=${folder.id}&folderName=${encodeURIComponent(folder.name)}">${folder.name}</a></li>`;
    });
    html += '</ul>';
    res.send(html);
});

app.get('/process-folder', async (req, res) => {
    try {
        const { folderId, folderName } = req.query;
        if (!folderId || !folderName) return res.redirect('/select-folder');
        if (!req.session.accessToken) return res.status(401).json({ error: "Unauthorized" });
        const auth = new google.auth.OAuth2();
        auth.setCredentials({ access_token: req.session.accessToken });

        let spreadsheetId = await createSpreadsheetInFolder(auth, folderId, folderName);
        const images = await listImagesInFolder(auth, folderId);
        const links = await scanBarcodesFromImages(images);
        if (links.length > 0) await updateSheet(auth, spreadsheetId, links);
        
        res.json({ message: `Processing complete for folder: ${folderId}`, spreadsheetId, links });
    } catch (error) {
        console.error("Error processing folder:", error);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

app.listen(port, () => {
    console.log(`✅ Server running on http://localhost:${port}`);
});
