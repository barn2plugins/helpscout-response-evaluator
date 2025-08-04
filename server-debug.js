const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Help Scout webhook endpoint - this is what Help Scout calls
app.post('/widget', async (req, res) => {
  try {
    console.log('=== Help Scout Request Start ===');
    console.log('Headers:', req.headers);
    console.log('Body:', JSON.stringify(req.body, null, 2));
    console.log('=== Help Scout Request End ===');
    
    // Return a simple success message for now
    return res.send(`
      <div style="padding: 20px; font-family: Arial, sans-serif;">
        <h3>📊 Response Evaluator</h3>
        <p><strong>Debug Mode Active</strong></p>
        <p>Received data from Help Scout successfully!</p>
        <p>Time: ${new Date().toISOString()}</p>
        <p>Data keys: ${Object.keys(req.body).join(', ')}</p>
        <p>Check Fly.io logs for full data structure.</p>
      </div>
    `);

  } catch (error) {
    console.error('=== ERROR ===');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('=== ERROR END ===');
    
    res.send(`
      <div style="padding: 20px; font-family: Arial, sans-serif;">
        <h3>📊 Response Evaluator</h3>
        <p style="color: red;"><strong>Error:</strong> ${error.message}</p>
        <p>Time: ${new Date().toISOString()}</p>
      </div>
    `);
  }
});

// Serve static widget for testing
app.get('/widget', (req, res) => {
  res.send(`
    <div style="padding: 20px; font-family: Arial, sans-serif;">
      <h3>📊 Response Evaluator</h3>
      <p>Widget is running! This endpoint should be called by Help Scout with POST data.</p>
      <p>Current time: ${new Date().toISOString()}</p>
      <p>Environment check:</p>
      <ul>
        <li>OpenAI Key: ${process.env.OPENAI_API_KEY ? 'Set' : 'Missing'}</li>
        <li>Help Scout Secret: ${process.env.HELPSCOUT_SECRET_KEY ? 'Set' : 'Missing'}</li>
      </ul>
    </div>
  `);
});

app.listen(PORT, () => {
  console.log(`Debug server running on port ${PORT}`);
  console.log('Environment variables check:');
  console.log('- OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'Set' : 'Missing');
  console.log('- HELPSCOUT_SECRET_KEY:', process.env.HELPSCOUT_SECRET_KEY ? 'Set' : 'Missing');
});