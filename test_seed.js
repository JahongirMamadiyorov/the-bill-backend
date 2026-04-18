const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: 'postgresql://postgres:postgres@localhost:5432/restaurant_db' });

async function seed() {
    try {
        const passwordHash = await bcrypt.hash('password123', 10);

        // Create users if not exist
        await pool.query(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES 
        ('Chef John', 'kitchen@restaurant.com', $1, 'kitchen'),
        ('Waitress Mary', 'waitress@restaurant.com', $1, 'waitress')
      ON CONFLICT (email) DO NOTHING
    `, [passwordHash]);

        console.log('Test users seeded (kitchen@restaurant.com, waitress@restaurant.com passwords: password123)');

        // Create a table
        const tableRes = await pool.query(`
      INSERT INTO restaurant_tables (table_number, capacity)
      VALUES (1, 4), (2, 2)
      ON CONFLICT (table_number) DO UPDATE SET capacity = EXCLUDED.capacity
      RETURNING id
    `);

        // Create categories
        const catRes = await pool.query(`
      INSERT INTO categories (name) VALUES ('Mains') RETURNING id
    `);

        // Create menu items
        const menuRes = await pool.query(`
      INSERT INTO menu_items (category_id, name, price)
      VALUES ($1, 'Burger', 10.99), ($1, 'Pizza', 12.99)
      RETURNING id
    `, [catRes.rows[0].id]);

        const getWaitress = await pool.query("SELECT id FROM users WHERE email='waitress@restaurant.com'");

        // Create a test order
        const orderRes = await pool.query(`
      INSERT INTO orders (table_id, waitress_id, status)
      VALUES ($1, $2, 'pending')
      RETURNING id
    `, [tableRes.rows[0].id, getWaitress.rows[0].id]);

        // Add items to order
        await pool.query(`
      INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price)
      VALUES ($1, $2, 2, 10.99), ($1, $3, 1, 12.99)
    `, [orderRes.rows[0].id, menuRes.rows[0].id, menuRes.rows[1].id]);

        console.log('Test order seeded.');
    } catch (err) {
        console.error('Seed error:', err);
    } finally {
        pool.end();
    }
}

seed();
