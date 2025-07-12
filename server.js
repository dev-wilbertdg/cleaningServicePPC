const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');  // voor file upload

// CONFIG
const PORT = 3000;
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// MIDDLEWARE
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Map voor uploads (maak aan als niet bestaat)
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// Multer setup voor Excel uploads (.xlsx/.xls)
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        // Unieke bestandsnaam om collisions te voorkomen
        const timestamp = Date.now();
        const ext = path.extname(file.originalname);
        const basename = path.basename(file.originalname, ext).replace(/\s+/g, '_');
        cb(null, `${basename}_${timestamp}${ext}`);
    }
});
const upload = multer({
    storage,
    fileFilter: function (req, file, cb) {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext !== '.xls' && ext !== '.xlsx') {
            return cb(new Error('Alleen Excel-bestanden (.xls, .xlsx) toegestaan'));
        }
        cb(null, true);
    }
});

// Metadata bestand voor uploads
const filesMetaPath = path.join(__dirname, 'files.json');

// Hulpfuncties om metadata te laden en opslaan
function loadFilesMeta() {
    if (!fs.existsSync(filesMetaPath)) {
        return [];
    }
    const data = fs.readFileSync(filesMetaPath, 'utf8');
    try {
        return JSON.parse(data);
    } catch {
        return [];
    }
}
function saveFilesMeta(meta) {
    fs.writeFileSync(filesMetaPath, JSON.stringify(meta, null, 2), 'utf8');
}

// --- Jouw bestaande huisnummers code blijft ongewijzigd ---
// (Ik neem aan dat dit gewoon onder deze lijn blijft)

// CSV PATH
const csvPath = path.join(__dirname, 'huisnummers.csv');
if (!fs.existsSync(csvPath)) {
    fs.writeFileSync(csvPath, 'timestamp,huisnummer,status\n', 'utf8');
}

app.post('/submit', (req, res) => {
    const huisnummer = req.body.huisnummer;
    const status = req.body.status || 'groen'; 
    const timestamp = new Date().toISOString();

    if (!huisnummer) {
        return res.status(400).json({ error: 'Huisnummer ontbreekt' });
    }
    let lijst = loadHuisnummers();
    const index = lijst.findIndex(h => h.huisnummer === huisnummer);

    if (index >= 0) {
        lijst[index].status = status;
        lijst[index].timestamp = timestamp;
    } else {
        lijst.push({ timestamp, huisnummer, status });
    }
    saveHuisnummers(lijst);
    io.emit('statusGewijzigd', { huisnummer, status });
    res.status(200).json({ message: 'Huisnummer ontvangen' });
});

app.get('/qrsubmit/:huisnummer', (req, res) => {
    const huisnummer = req.params.huisnummer;
    const status = 'groen';
    const timestamp = new Date().toISOString();

    if (!huisnummer) {
        return res.status(400).send('Huisnummer ontbreekt');
    }
    let lijst = loadHuisnummers();
    const index = lijst.findIndex(h => h.huisnummer === huisnummer);

    if (index >= 0) {
        lijst[index].status = status;
        lijst[index].timestamp = timestamp;
    } else {
        lijst.push({ timestamp, huisnummer, status });
    }
    saveHuisnummers(lijst);
    io.emit('statusGewijzigd', { huisnummer, status });

    res.send(`
        <!DOCTYPE html>
        <html lang="nl">
        <head>
            <script>setTimeout(() => {
                window.close();
            }, 5000);</script>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>✅ Verzonden</title>
            <style>
                body {
                    font-family: sans-serif;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    text-align: center;
                    justify-content: center;
                    height: 100vh;
                    background-color: #f0fff0;
                    color: #2e7d32;
                }
                .emoji {
                    font-size: 100px;
                    margin-bottom: 20px;
                }
                h1 {
                    font-size: 2em;
                    margin: 0;
                }
                p {
                    font-size: 1.2em;
                    margin-top: 10px;
                }
            </style>
        </head>
        <body>
            <div class="emoji">✅</div>
            <h1>Huisje ${huisnummer} gemarkeerd als schoongemaakt!</h1>
        </body>
        </html>
    `);
});

function loadHuisnummers() {
    const data = fs.readFileSync(csvPath, 'utf8');
    const lines = data.trim().split('\n');
    const arr = [];
    for (let i = 1; i < lines.length; i++) {
        const [timestamp, huisnummer, status] = lines[i].split(',');
        arr.push({ timestamp, huisnummer, status });
    }
    return arr;
}

function saveHuisnummers(arr) {
    const lines = ['timestamp,huisnummer,status'];
    for (const item of arr) {
        lines.push(`${item.timestamp},${item.huisnummer},${item.status}`);
    }
    fs.writeFileSync(csvPath, lines.join('\n'), 'utf8');
}

io.on('connection', (socket) => {
    console.log('Nieuwe client verbonden');
    const huisnummers = loadHuisnummers();
    socket.emit('initVerzonden', huisnummers);

    socket.on('changeStatus', ({ huisnummer, status }) => {
        console.log(`Status wijziging: ${huisnummer} -> ${status}`);
        let lijst = loadHuisnummers();
        const index = lijst.findIndex(h => h.huisnummer === huisnummer);
        if (index >= 0) {
            lijst[index].status = status;
            lijst[index].timestamp = new Date().toISOString();
        } else {
            lijst.push({ timestamp: new Date().toISOString(), huisnummer, status });
        }
        saveHuisnummers(lijst);
        io.emit('statusGewijzigd', { huisnummer, status });
    });
});

// ------------------ NIEUWE ENDPOINTS voor Excel upload + beheer ----------------

// Upload endpoint met activatietijd in body (ISO string)
app.post('/upload', upload.single('excel'), (req, res) => {
    const activatieTijd = req.body.activeTime;
    if (!req.file) {
        return res.status(400).json({ error: 'Geen bestand geüpload' });
    }
    if (!activatieTijd || isNaN(Date.parse(activatieTijd))) {
        return res.status(400).json({ error: 'Ongeldige of ontbrekende activatietijd' });
    }

    const files = loadFilesMeta();
    files.push({
        id: Date.now().toString(),
        filename: req.file.filename,
        originalName: req.file.originalname,
        activatieTijd,
        uploadedAt: new Date().toISOString()
    });
    console.log(`Bestand geüpload: ${req.file.filename}, Activatietijd: ${activatieTijd}, ${JSON.stringify(files)}`);
    saveFilesMeta(files);

    res.status(200).json({ message: 'Bestand succesvol geüpload', file: req.file.filename });
});

// Endpoint om alle geüploade bestanden te krijgen
app.get('/files', (req, res) => {
    const files = loadFilesMeta();
    res.json(files);
});

app.get('/files/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(uploadDir, filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Bestand niet gevonden' });
    }
    res.download(filePath, filename, (err) => {
        if (err) {
            console.error('Download fout:', err);
            res.status(500).json({ error: 'Download fout' });
        }
    });
});

// Endpoint om een bestand te verwijderen (via id)
app.delete('/files/delete/:id', (req, res) => {
    const id = req.params.id;
    let files = loadFilesMeta();
    const index = files.findIndex(f => f.id === id);
    if (index === -1) {
        return res.status(404).json({ error: 'Bestand niet gevonden' });
    }

    const fileToDelete = files[index];
    const filePath = path.join(uploadDir, fileToDelete.filename);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
    
    files.splice(index, 1);
    saveFilesMeta(files);
    console.log(`Bestand verwijderd: ${fileToDelete.filename}`);
    
    res.status(200).json({ message: 'Bestand succesvol verwijderd' });
});

// START SERVER
server.listen(PORT, () => {
    const ip = require('ip');
    console.log(`Server draait op http://${ip.address()}:${PORT}`);
});
