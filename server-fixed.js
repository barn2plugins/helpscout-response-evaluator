const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Help Scout webhook endpoint - this is what Help Scout calls
app.post('/', async (req, res) => {
  try {
    console.log('=== Help Scout Request Start ===');
    console.log('URL Parameters:', req.query);
    console.log('Route Parameters:', req.params);
    console.log('=== Help Scout Request End ===');
    
    // Get ticket/conversation data from URL parameters
    const ticketData = {
      id: req.query['ticket[id]'],
      number: req.query['ticket[number]'],
      subject: req.query['ticket[subject]'],
      customer: {
        id: req.query['customer[id]'],
        firstName: req.query['customer[fname]'],
        lastName: req.query['customer[lname]'],
        email: req.query['customer[email]'],
        emails: req.query['customer[emails]'] || []
      }
    };
    
    if (!ticketData.id) {
      return res.json({
        html: `
          <div style="padding: 20px; font-family: Arial, sans-serif;">
            <h3>📊 Response Evaluator</h3>
            <p>No ticket data received from Help Scout.</p>
          </div>
        `
      });
    }

    // For now, return a simple success message with the data we received
    const html = `
      <div style="padding: 20px; font-family: Arial, sans-serif;">
        <h3>📊 Response Evaluator</h3>
        <p><strong>Successfully connected!</strong></p>
        <p><strong>Ticket:</strong> #${ticketData.number}</p>
        <p><strong>Subject:</strong> ${ticketData.subject}</p>
        <p><strong>Customer:</strong> ${ticketData.customer.firstName} ${ticketData.customer.lastName}</p>
        <p><strong>Email:</strong> ${ticketData.customer.email}</p>
        <p>Time: ${new Date().toISOString()}</p>
        <hr>
        <p><em>Next step: Add conversation analysis...</em></p>
      </div>
    `;
    
    // Help Scout expects JSON response with 'html' field
    res.json({ html: html });

  } catch (error) {
    console.error('=== ERROR ===');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('=== ERROR END ===');
    
    res.json({
      html: `
        <div style="padding: 20px; font-family: Arial, sans-serif;">
          <h3>📊 Response Evaluator</h3>
          <p style="color: red;"><strong>Error:</strong> ${error.message}</p>
          <p>Time: ${new Date().toISOString()}</p>
        </div>
      `
    });
  }
});

// Serve static widget for testing
app.get('/widget', (req, res) => {
  res.send(`
    <div style="padding: 20px; font-family: Arial, sans-serif;">
      <h3>📊 Response Evaluator</h3>
      <p>Widget is running! Help Scout should call a different endpoint.</p>
      <p>Current time: ${new Date().toISOString()}</p>
      <p>Environment check:</p>
      <ul>
        <li>OpenAI Key: ${process.env.OPENAI_API_KEY ? 'Set' : 'Missing'}</li>
        <li>Help Scout Secret: ${process.env.HELPSCOUT_SECRET_KEY ? 'Set' : 'Missing'}</li>
      </ul>
    </div>
  `);
});

// Catch-all route for debugging
app.all('*', (req, res) => {
  console.log('=== UNKNOWN REQUEST ===');
  console.log('Method:', req.method);
  console.log('URL:', req.url);
  console.log('Path:', req.path);
  console.log('Query:', req.query);
  console.log('=== END UNKNOWN REQUEST ===');
  
  res.json({
    html: `
      <div style="padding: 20px; font-family: Arial, sans-serif;">
        <h3>📊 Response Evaluator - Debug</h3>
        <p><strong>URL called:</strong> ${req.url}</p>
        <p><strong>Method:</strong> ${req.method}</p>
        <p><strong>Path:</strong> ${req.path}</p>
      </div>
    `
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Fixed server running on 0.0.0.0:${PORT}`);
  console.log('Environment variables check:');
  console.log('- OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'Set' : 'Missing');
  console.log('- HELPSCOUT_SECRET_KEY:', process.env.HELPSCOUT_SECRET_KEY ? 'Set' : 'Missing');
});
