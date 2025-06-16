const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const port = 3000;

// PostgreSQL connection
const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'ai_testbench',
    password: process.env.DB_PASS || 'postgresql',
    port: process.env.DB_PORT || 5432,
});

// Middleware
app.use(express.json());

/**
 * ✅ GET /users - Get all users
 */
app.get('/getallusers', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * ✅ GET /users/:id - Get user by ID
 * ✅ GET /users/search?name=shubh OR ?email=shubh@example.com
 */
app.get('/getuserbyid/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM users WHERE user_id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching user by ID:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/getuser/search', async (req, res) => {
    try {
        const { name, email, phone } = req.query;
        let result;

        if (name) {
            result = await pool.query('SELECT * FROM users WHERE name ILIKE $1', [`%${name}%`]);
        } else if (email) {
            result = await pool.query('SELECT * FROM users WHERE email ILIKE $1', [`%${email}%`]);
        } else if (phone) {
            result = await pool.query('SELECT * FROM users WHERE phone ILIKE $1', [`%${phone}%`]);
        } else {
            return res.status(400).json({ error: 'Provide name or email to search' });
        }

        res.json(result.rows);
    } catch (err) {
        console.error('Error searching user:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * ✅ POST /users - Add new user
**/

app.post('/adduser', async (req, res) => {
    try {
        const { name, email, phone } = req.body;
        if (!name || !email || !phone) {
            return res.status(400).json({ error: 'Name and email are required' });
        }

        const insertQuery = 'INSERT INTO users(name, email, phone) VALUES($1, $2, $3) RETURNING *';
        const result = await pool.query(insertQuery, [name, email, phone]);

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error adding user:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.delete('/deleteuser/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM users WHERE user_id = $1 RETURNING *', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({ message: 'User deleted successfully', user: result.rows[0] });
    } catch (err) {
        console.error('❌ Error deleting user:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


// async function dropUsersTable() {
//   try {
//     await pool.query('DROP TABLE IF EXISTS users');
//     console.log('✅ Table "users" has been dropped.');
//   } catch (err) {
//     console.error('❌ Error dropping table:', err);
//   }
// }

// dropUsersTable();


// Start server



app.listen(port, () => {
    console.log(`🚀 Server running at http://localhost:${port}`);
});