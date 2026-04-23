const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Test database connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection error:', err.message);
    } else {
        console.log('✅ Connected to Supabase PostgreSQL!');
        release();
    }
});

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
        cb(null, unique + '.jpg');
    }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Image compression function
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

// Create tables in Supabase
async function initDatabase() {
    const queries = [
        `CREATE TABLE IF NOT EXISTS cars (
            id SERIAL PRIMARY KEY,
            make TEXT, model TEXT, year INTEGER, price INTEGER,
            km TEXT, fuel TEXT, trans TEXT, color TEXT,
            own TEXT, reg TEXT, description TEXT, status TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS car_images (
            id SERIAL PRIMARY KEY,
            car_id INTEGER REFERENCES cars(id) ON DELETE CASCADE,
            image_path TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS seller_inquiries (
            id SERIAL PRIMARY KEY,
            name TEXT, phone TEXT, email TEXT, make TEXT,
            model TEXT, year TEXT, km TEXT, own TEXT, notes TEXT,
            contacted INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS buyer_inquiries (
            id SERIAL PRIMARY KEY,
            car_id INTEGER, car_name TEXT, name TEXT,
            phone TEXT, email TEXT, message TEXT,
            contacted INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS reviews (
            id SERIAL PRIMARY KEY,
            name TEXT, city TEXT, car TEXT, rating INTEGER,
            review_text TEXT, verified INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS admin (
            id SERIAL PRIMARY KEY,
            username TEXT, password TEXT
        )`,
        `INSERT INTO admin (username, password) SELECT 'admin', 'admin123' WHERE NOT EXISTS (SELECT 1 FROM admin WHERE username='admin')`
    ];
    
    for (const query of queries) {
        try {
            await pool.query(query);
        } catch (err) {
            console.log('Table may already exist:', err.message);
        }
    }
    console.log('✅ Database tables ready');
}

initDatabase();

// ============ API ROUTES ============

app.get('/api/cars', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT c.*, 
            (SELECT image_path FROM car_images WHERE car_id = c.id LIMIT 1) as image 
            FROM cars c ORDER BY c.created_at DESC
        `);
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/cars/:id', async (req, res) => {
    try {
        const carResult = await pool.query('SELECT * FROM cars WHERE id = $1', [req.params.id]);
        if (carResult.rows.length === 0) {
            return res.status(404).json({ error: 'Car not found' });
        }
        const imagesResult = await pool.query('SELECT image_path FROM car_images WHERE car_id = $1', [req.params.id]);
        res.json({ ...carResult.rows[0], images: imagesResult.rows.map(i => i.image_path) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM admin WHERE username = $1 AND password = $2', [username, password]);
        if (result.rows.length > 0) {
            req.session.regenerate((err) => {
                req.session.admin = true;
                req.session.save();
                res.json({ success: true });
            });
        } else {
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/check', (req, res) => {
    res.json({ loggedIn: !!req.session.admin });
});

app.post('/api/admin/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.post('/api/admin/cars', upload.array('images', 15), async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    const { make, model, year, price, km, fuel, trans, color, own, reg, description, status } = req.body;
    
    try {
        const result = await pool.query(
            `INSERT INTO cars (make, model, year, price, km, fuel, trans, color, own, reg, description, status) 
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
            [make, model, year, price, km, fuel, trans, color, own, reg, description, status || 'available']
        );
        const carId = result.rows[0].id;
        
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const originalPath = file.path;
                const compressedPath = originalPath.replace('.jpg', '_comp.jpg');
                await compressImage(originalPath, compressedPath);
                if (fs.existsSync(compressedPath)) {
                    fs.renameSync(compressedPath, originalPath);
                }
                await pool.query('INSERT INTO car_images (car_id, image_path) VALUES ($1, $2)', 
                    [carId, '/uploads/' + path.basename(originalPath)]);
            }
        }
        res.json({ success: true, carId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/cars/:id', upload.array('newImages', 15), async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    const { make, model, year, price, km, fuel, trans, color, own, reg, description, status } = req.body;
    
    try {
        await pool.query(
            `UPDATE cars SET make=$1, model=$2, year=$3, price=$4, km=$5, fuel=$6, trans=$7, color=$8, own=$9, reg=$10, description=$11, status=$12
             WHERE id=$13`,
            [make, model, year, price, km, fuel, trans, color, own, reg, description, status, req.params.id]
        );
        
        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                const originalPath = file.path;
                const compressedPath = originalPath.replace('.jpg', '_comp.jpg');
                await compressImage(originalPath, compressedPath);
                if (fs.existsSync(compressedPath)) {
                    fs.renameSync(compressedPath, originalPath);
                }
                await pool.query('INSERT INTO car_images (car_id, image_path) VALUES ($1, $2)', 
                    [req.params.id, '/uploads/' + path.basename(originalPath)]);
            }
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/cars/:id', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const images = await pool.query('SELECT image_path FROM car_images WHERE car_id = $1', [req.params.id]);
        images.rows.forEach(img => {
            const filePath = path.join(__dirname, 'public', img.image_path);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        });
        await pool.query('DELETE FROM car_images WHERE car_id = $1', [req.params.id]);
        await pool.query('DELETE FROM cars WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.patch('/api/admin/cars/:id/status', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const { status } = req.body;
    await pool.query('UPDATE cars SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.json({ success: true });
});

app.post('/api/sell', async (req, res) => {
    const { name, phone, email, make, model, year, km, own, notes } = req.body;
    await pool.query(
        `INSERT INTO seller_inquiries (name, phone, email, make, model, year, km, own, notes) 
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [name, phone, email, make, model, year, km, own, notes]
    );
    res.json({ success: true });
});

app.post('/api/inquire', async (req, res) => {
    const { car_id, car_name, name, phone, email, message } = req.body;
    await pool.query(
        `INSERT INTO buyer_inquiries (car_id, car_name, name, phone, email, message) 
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [car_id, car_name, name, phone, email, message]
    );
    res.json({ success: true });
});

app.get('/api/admin/seller-inquiries', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const result = await pool.query('SELECT * FROM seller_inquiries ORDER BY contacted ASC, created_at DESC');
    res.json(result.rows);
});

app.patch('/api/admin/seller-inquiries/:id/contacted', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const { contacted } = req.body;
    await pool.query('UPDATE seller_inquiries SET contacted = $1 WHERE id = $2', [contacted, req.params.id]);
    res.json({ success: true });
});

app.get('/api/admin/buyer-inquiries', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const result = await pool.query('SELECT * FROM buyer_inquiries ORDER BY contacted ASC, created_at DESC');
    res.json(result.rows);
});

app.patch('/api/admin/buyer-inquiries/:id/contacted', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    const { contacted } = req.body;
    await pool.query('UPDATE buyer_inquiries SET contacted = $1 WHERE id = $2', [contacted, req.params.id]);
    res.json({ success: true });
});

app.get('/api/reviews', async (req, res) => {
    const result = await pool.query('SELECT * FROM reviews ORDER BY created_at DESC');
    res.json(result.rows);
});

app.post('/api/reviews', async (req, res) => {
    const { name, city, car, rating, review_text } = req.body;
    await pool.query(
        `INSERT INTO reviews (name, city, car, rating, review_text, verified) 
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [name, city, car, rating, review_text, 0]
    );
    res.json({ success: true });
});

app.delete('/api/admin/reviews/:id', async (req, res) => {
    if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
    await pool.query('DELETE FROM reviews WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});

app.get('/api/brands', async (req, res) => {
    const result = await pool.query('SELECT DISTINCT make FROM cars WHERE make IS NOT NULL');
    res.json(result.rows.map(r => r.make));
});

app.post('/api/admin/reset-password', async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }
    await pool.query('UPDATE admin SET password = $1 WHERE id = 1', [newPassword]);
    res.json({ success: true });
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`\n🚗 ========== UCARS MARKETPLACE ==========`);
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`🗄️ Database: Supabase PostgreSQL (PERSISTENT!)`);
    console.log(`🖼️ Image compression ENABLED`);
    console.log(`=========================================\n`);
});
