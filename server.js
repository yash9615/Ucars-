const express = require('express');
const multer = require('multer');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const session = require('express-session');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = 3000;

// Security middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Session configuration - FIXED for persistent login
app.use(session({
    secret: 'ucars_super_secret_key_2025',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
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
        cb(null, unique + path.extname(file.originalname));
    }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Database setup
const db = new sqlite3.Database('ucars.db');

db.serialize(() => {
    // Cars table
    db.run(`CREATE TABLE IF NOT EXISTS cars (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        make TEXT, model TEXT, year INTEGER, price INTEGER,
        km TEXT, fuel TEXT, trans TEXT, color TEXT,
        own TEXT, reg TEXT, description TEXT, status TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Images table
    db.run(`CREATE TABLE IF NOT EXISTS car_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        car_id INTEGER, image_path TEXT,
        FOREIGN KEY(car_id) REFERENCES cars(id) ON DELETE CASCADE
    )`);
    
    // Seller inquiries with contacted status
    db.run(`CREATE TABLE IF NOT EXISTS seller_inquiries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT, phone TEXT, email TEXT, make TEXT,
        model TEXT, year TEXT, km TEXT, own TEXT, notes TEXT,
        contacted INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Buyer inquiries with contacted status
    db.run(`CREATE TABLE IF NOT EXISTS buyer_inquiries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        car_id INTEGER, car_name TEXT, name TEXT,
        phone TEXT, email TEXT, message TEXT,
        contacted INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Reviews table
    db.run(`CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT, city TEXT, car TEXT, rating INTEGER,
        review_text TEXT, verified INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    // Admin table
    db.run(`CREATE TABLE IF NOT EXISTS admin (
        id INTEGER PRIMARY KEY,
        username TEXT, password TEXT
    )`);
    
    // Insert default admin
    db.get("SELECT * FROM admin WHERE id = 1", (err, row) => {
        if (!row) {
            db.run("INSERT INTO admin (id, username, password) VALUES (1, 'admin', 'admin123')", (err) => {
                if (!err) console.log('✅ Admin created: admin / admin123');
            });
        } else {
            console.log('✅ Admin exists: admin / admin123');
        }
    });
});

// ============ API ROUTES ============

// Get all cars
app.get('/api/cars', (req, res) => {
    db.all(`SELECT c.*, 
            (SELECT image_path FROM car_images WHERE car_id = c.id LIMIT 1) as image 
            FROM cars c ORDER BY c.created_at DESC`, (err, cars) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(cars || []);
    });
});

// Get single car with images
app.get('/api/cars/:id', (req, res) => {
    db.get("SELECT * FROM cars WHERE id = ?", [req.params.id], (err, car) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!car) return res.status(404).json({ error: 'Car not found' });
        db.all("SELECT image_path FROM car_images WHERE car_id = ?", [req.params.id], (err, images) => {
            res.json({ ...car, images: images.map(i => i.image_path) });
        });
    });
});

// Admin login - FIXED persistent session
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    console.log('Login attempt:', username);
    
    db.get("SELECT * FROM admin WHERE username = ? AND password = ?", [username, password], (err, admin) => {
        if (err) {
            console.log('Database error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (admin) {
            req.session.regenerate((err) => {
                if (err) return res.status(500).json({ error: 'Session error' });
                req.session.admin = true;
                req.session.adminUser = username;
                req.session.save((err) => {
                    if (err) return res.status(500).json({ error: 'Session save error' });
                    console.log('Login successful for:', username);
                    res.json({ success: true });
                });
            });
        } else {
            console.log('Login failed for:', username);
            res.status(401).json({ error: 'Invalid credentials. Use admin / admin123' });
        }
    });
});

// Check admin session
app.get('/api/admin/check', (req, res) => {
    res.json({ loggedIn: !!req.session.admin });
});

// Admin logout
app.post('/api/admin/logout', (req, res) => {
    req.session.destroy((err) => {
        res.json({ success: true });
    });
});

// Add car with images
app.post('/api/admin/cars', upload.array('images', 15), (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    const { make, model, year, price, km, fuel, trans, color, own, reg, description, status } = req.body;
    
    db.run(`INSERT INTO cars (make, model, year, price, km, fuel, trans, color, own, reg, description, status) 
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [make, model, year, price, km, fuel, trans, color, own, reg, description, status || 'available'],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            const carId = this.lastID;
            if (req.files && req.files.length > 0) {
                req.files.forEach(file => {
                    db.run("INSERT INTO car_images (car_id, image_path) VALUES (?, ?)", [carId, '/uploads/' + file.filename]);
                });
            }
            res.json({ success: true, carId });
        });
});

// Update car
app.put('/api/admin/cars/:id', upload.array('newImages', 15), (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    const { make, model, year, price, km, fuel, trans, color, own, reg, description, status } = req.body;
    
    db.run(`UPDATE cars SET make=?, model=?, year=?, price=?, km=?, fuel=?, trans=?, color=?, own=?, reg=?, description=?, status=?
            WHERE id=?`,
        [make, model, year, price, km, fuel, trans, color, own, reg, description, status, req.params.id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (req.files && req.files.length > 0) {
                req.files.forEach(file => {
                    db.run("INSERT INTO car_images (car_id, image_path) VALUES (?, ?)", [req.params.id, '/uploads/' + file.filename]);
                });
            }
            res.json({ success: true });
        });
});

// Delete car
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

// Toggle car status
app.patch('/api/admin/cars/:id/status', (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const { status } = req.body;
    db.run("UPDATE cars SET status = ? WHERE id = ?", [status, req.params.id], (err) => {
        res.json({ success: true });
    });
});

// Seller inquiry
app.post('/api/sell', (req, res) => {
    const { name, phone, email, make, model, year, km, own, notes } = req.body;
    db.run(`INSERT INTO seller_inquiries (name, phone, email, make, model, year, km, own, notes) 
            VALUES (?,?,?,?,?,?,?,?,?)`,
        [name, phone, email, make, model, year, km, own, notes], (err) => {
            res.json({ success: true });
        });
});

// Buyer inquiry
app.post('/api/inquire', (req, res) => {
    const { car_id, car_name, name, phone, email, message } = req.body;
    db.run(`INSERT INTO buyer_inquiries (car_id, car_name, name, phone, email, message) 
            VALUES (?,?,?,?,?,?)`,
        [car_id, car_name, name, phone, email, message], (err) => {
            res.json({ success: true });
        });
});

// Get seller inquiries (admin) with contacted status
app.get('/api/admin/seller-inquiries', (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    db.all("SELECT * FROM seller_inquiries ORDER BY contacted ASC, created_at DESC", (err, rows) => {
        res.json(rows || []);
    });
});

// Update seller inquiry contacted status
app.patch('/api/admin/seller-inquiries/:id/contacted', (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const { contacted } = req.body;
    db.run("UPDATE seller_inquiries SET contacted = ? WHERE id = ?", [contacted, req.params.id], (err) => {
        res.json({ success: true });
    });
});

// Get buyer inquiries (admin) with contacted status
app.get('/api/admin/buyer-inquiries', (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    db.all("SELECT * FROM buyer_inquiries ORDER BY contacted ASC, created_at DESC", (err, rows) => {
        res.json(rows || []);
    });
});

// Update buyer inquiry contacted status
app.patch('/api/admin/buyer-inquiries/:id/contacted', (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const { contacted } = req.body;
    db.run("UPDATE buyer_inquiries SET contacted = ? WHERE id = ?", [contacted, req.params.id], (err) => {
        res.json({ success: true });
    });
});

// Get reviews
app.get('/api/reviews', (req, res) => {
    db.all("SELECT * FROM reviews ORDER BY created_at DESC", (err, rows) => {
        res.json(rows || []);
    });
});

// Add review
app.post('/api/reviews', (req, res) => {
    const { name, city, car, rating, review_text } = req.body;
    db.run(`INSERT INTO reviews (name, city, car, rating, review_text, verified) 
            VALUES (?,?,?,?,?,?)`,
        [name, city, car, rating, review_text, 0], (err) => {
            res.json({ success: true });
        });
});

// Delete review (admin)
app.delete('/api/admin/reviews/:id', (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    db.run("DELETE FROM reviews WHERE id = ?", [req.params.id], (err) => {
        res.json({ success: true });
    });
});

// Get brands for filter
app.get('/api/brands', (req, res) => {
    db.all("SELECT DISTINCT make FROM cars WHERE make IS NOT NULL", (err, rows) => {
        res.json(rows.map(r => r.make));
    });
});

// Serve HTML pages
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
// Password reset endpoint (remove after use for security)
app.post('/api/admin/reset-password', (req, res) => {
    const { newPassword } = req.body;
    
    if (!newPassword || newPassword.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }
    
    db.run("UPDATE admin SET password = ? WHERE id = 1", [newPassword], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        console.log('✅ Admin password changed!');
        res.json({ success: true, message: 'Password updated' });
    });
});
app.listen(PORT, () => {
    console.log(`\n🚗 ========== UCARS MARKETPLACE ==========`);
    console.log(`✅ Server: http://localhost:${PORT}`);
    console.log(`📱 Website: http://localhost:${PORT}`);
    console.log(`🔑 Admin Panel: http://localhost:${PORT}/admin`);
    console.log(`👤 Login: admin / admin123`);
    console.log(`=========================================\n`);
});
