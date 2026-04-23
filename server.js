const express = require('express');
const multer = require('multer');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const session = require('express-session');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp'); // ADDED FOR IMAGE COMPRESSION

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'ucars_secret_key_2025',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// Create folders
if (!fs.existsSync('public')) fs.mkdirSync('public');
if (!fs.existsSync('public/uploads')) fs.mkdirSync('public/uploads');

// File upload configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads/'),
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, unique + '.jpg'); // Force .jpg extension
    }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// FUNCTION TO COMPRESS IMAGE
async function compressImage(inputPath, outputPath) {
    try {
        await sharp(inputPath)
            .resize(1200, 800, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 75, progressive: true })
            .toFile(outputPath);
        return true;
    } catch (error) {
        console.error('Compression error:', error);
        return false;
    }
}

// Database setup
const db = new sqlite3.Database('ucars.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS cars (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        make TEXT, model TEXT, year INTEGER, price INTEGER,
        km TEXT, fuel TEXT, trans TEXT, color TEXT,
        own TEXT, reg TEXT, description TEXT, status TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS car_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        car_id INTEGER, image_path TEXT,
        FOREIGN KEY(car_id) REFERENCES cars(id) ON DELETE CASCADE
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS seller_inquiries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT, phone TEXT, email TEXT, make TEXT,
        model TEXT, year TEXT, km TEXT, own TEXT, notes TEXT,
        contacted INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS buyer_inquiries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        car_id INTEGER, car_name TEXT, name TEXT,
        phone TEXT, email TEXT, message TEXT,
        contacted INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT, city TEXT, car TEXT, rating INTEGER,
        review_text TEXT, verified INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS admin (
        id INTEGER PRIMARY KEY,
        username TEXT, password TEXT
    )`);
    
    db.get("SELECT * FROM admin WHERE id = 1", (err, row) => {
        if (!row) {
            db.run("INSERT INTO admin (id, username, password) VALUES (1, 'admin', 'admin123')");
            console.log('✅ Admin created: admin / admin123');
        }
    });
});

// ============ API ROUTES ============

app.get('/api/cars', (req, res) => {
    db.all(`SELECT c.*, 
            (SELECT image_path FROM car_images WHERE car_id = c.id LIMIT 1) as image 
            FROM cars c ORDER BY c.created_at DESC`, (err, cars) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(cars || []);
    });
});

app.get('/api/cars/:id', (req, res) => {
    db.get("SELECT * FROM cars WHERE id = ?", [req.params.id], (err, car) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!car) return res.status(404).json({ error: 'Car not found' });
        db.all("SELECT image_path FROM car_images WHERE car_id = ?", [req.params.id], (err, images) => {
            res.json({ ...car, images: images.map(i => i.image_path) });
        });
    });
});

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM admin WHERE username = ? AND password = ?", [username, password], (err, admin) => {
        if (admin) {
            req.session.regenerate((err) => {
                req.session.admin = true;
                req.session.save();
                res.json({ success: true });
            });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    });
});

app.get('/api/admin/check', (req, res) => {
    res.json({ loggedIn: !!req.session.admin });
});

app.post('/api/admin/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// ADD CAR WITH AUTO-COMPRESSION
app.post('/api/admin/cars', upload.array('images', 15), async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    const { make, model, year, price, km, fuel, trans, color, own, reg, description, status } = req.body;
    
    db.run(`INSERT INTO cars (make, model, year, price, km, fuel, trans, color, own, reg, description, status) 
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [make, model, year, price, km, fuel, trans, color, own, reg, description, status || 'available'],
        async function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const carId = this.lastID;
            
            if (req.files && req.files.length > 0) {
                for (const file of req.files) {
                    const originalPath = file.path;
                    const compressedPath = originalPath.replace('.jpg', '_comp.jpg');
                    
                    // Compress the image
                    await compressImage(originalPath, compressedPath);
                    
                    // Replace original with compressed
                    if (fs.existsSync(compressedPath)) {
                        fs.renameSync(compressedPath, originalPath);
                    }
                    
                    db.run("INSERT INTO car_images (car_id, image_path) VALUES (?, ?)", 
                        [carId, '/uploads/' + path.basename(originalPath)]);
                }
            }
            res.json({ success: true, carId });
        });
});

// UPDATE CAR WITH AUTO-COMPRESSION
app.put('/api/admin/cars/:id', upload.array('newImages', 15), async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    const { make, model, year, price, km, fuel, trans, color, own, reg, description, status } = req.body;
    
    db.run(`UPDATE cars SET make=?, model=?, year=?, price=?, km=?, fuel=?, trans=?, color=?, own=?, reg=?, description=?, status=?
            WHERE id=?`,
        [make, model, year, price, km, fuel, trans, color, own, reg, description, status, req.params.id],
        async function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            if (req.files && req.files.length > 0) {
                for (const file of req.files) {
                    const originalPath = file.path;
                    const compressedPath = originalPath.replace('.jpg', '_comp.jpg');
                    
                    await compressImage(originalPath, compressedPath);
                    
                    if (fs.existsSync(compressedPath)) {
                        fs.renameSync(compressedPath, originalPath);
                    }
                    
                    db.run("INSERT INTO car_images (car_id, image_path) VALUES (?, ?)", 
                        [req.params.id, '/uploads/' + path.basename(originalPath)]);
                }
            }
            res.json({ success: true });
        });
});

app.delete('/api/admin/cars/:id', (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    db.all("SELECT image_path FROM car_images WHERE car_id = ?", [req.params.id], (err, images) => {
        images.forEach(img => {
            const filePath = path.join(__dirname, 'public', img.image_path);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        });
        db.run("DELETE FROM car_images WHERE car_id = ?", [req.params.id]);
        db.run("DELETE FROM cars WHERE id = ?", [req.params.id], (err) => {
            res.json({ success: true });
        });
    });
});

app.patch('/api/admin/cars/:id/status', (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const { status } = req.body;
    db.run("UPDATE cars SET status = ? WHERE id = ?", [status, req.params.id], (err) => {
        res.json({ success: true });
    });
});

app.post('/api/sell', (req, res) => {
    const { name, phone, email, make, model, year, km, own, notes } = req.body;
    db.run(`INSERT INTO seller_inquiries (name, phone, email, make, model, year, km, own, notes) 
            VALUES (?,?,?,?,?,?,?,?,?)`,
        [name, phone, email, make, model, year, km, own, notes], (err) => {
            res.json({ success: true });
        });
});

app.post('/api/inquire', (req, res) => {
    const { car_id, car_name, name, phone, email, message } = req.body;
    db.run(`INSERT INTO buyer_inquiries (car_id, car_name, name, phone, email, message) 
            VALUES (?,?,?,?,?,?)`,
        [car_id, car_name, name, phone, email, message], (err) => {
            res.json({ success: true });
        });
});

app.get('/api/admin/seller-inquiries', (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    db.all("SELECT * FROM seller_inquiries ORDER BY contacted ASC, created_at DESC", (err, rows) => {
        res.json(rows || []);
    });
});

app.patch('/api/admin/seller-inquiries/:id/contacted', (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const { contacted } = req.body;
    db.run("UPDATE seller_inquiries SET contacted = ? WHERE id = ?", [contacted, req.params.id], (err) => {
        res.json({ success: true });
    });
});

app.get('/api/admin/buyer-inquiries', (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    db.all("SELECT * FROM buyer_inquiries ORDER BY contacted ASC, created_at DESC", (err, rows) => {
        res.json(rows || []);
    });
});

app.patch('/api/admin/buyer-inquiries/:id/contacted', (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const { contacted } = req.body;
    db.run("UPDATE buyer_inquiries SET contacted = ? WHERE id = ?", [contacted, req.params.id], (err) => {
        res.json({ success: true });
    });
});

app.get('/api/reviews', (req, res) => {
    db.all("SELECT * FROM reviews ORDER BY created_at DESC", (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/reviews', (req, res) => {
    const { name, city, car, rating, review_text } = req.body;
    db.run(`INSERT INTO reviews (name, city, car, rating, review_text, verified) 
            VALUES (?,?,?,?,?,?)`,
        [name, city, car, rating, review_text, 0], (err) => {
            res.json({ success: true });
        });
});

app.delete('/api/admin/reviews/:id', (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    db.run("DELETE FROM reviews WHERE id = ?", [req.params.id], (err) => {
        res.json({ success: true });
    });
});

app.get('/api/brands', (req, res) => {
    db.all("SELECT DISTINCT make FROM cars WHERE make IS NOT NULL", (err, rows) => {
        res.json(rows.map(r => r.make));
    });
});

// Password reset endpoint
app.post('/api/admin/reset-password', (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }
    db.run("UPDATE admin SET password = ? WHERE id = 1", [newPassword], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Serve HTML pages
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`\n🚗 ========== UCARS MARKETPLACE ==========`);
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`🖼️ Image compression ENABLED (1200px, 75% quality)`);
    console.log(`=========================================\n`);
});
