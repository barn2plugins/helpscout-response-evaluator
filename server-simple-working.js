const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Help Scout dynamic app endpoint
app.post('/', async (req, res) => {
  try {
    console.log('=== Help Scout Data ===');
    console.log('Body:', JSON.stringify(req.body, null, 2));
    
    const { ticket, customer, user, mailbox } = req.body;
    
    if (!ticket || !ticket.id) {
      return res.json({
        html: `
          <div style="padding: 20px; font-family: Arial, sans-serif;">
            <h3>📊 Response Evaluator</h3>
            <p>No ticket data received.</p>
          </div>
        `
      });
    }

    // Simple success response with ticket data
    const html = `
      <div style="padding: 20px; font-family: Arial, sans-serif; max-width: 300px;">
        <h3 style="color: #2c5aa0; font-size: 14px; margin: 0 0 16px 0;">📊 Response Evaluator</h3>
        
        <div style="background: #f0f8f0; padding: 12px; border-radius: 4px; margin-bottom: 12px;">
          <h4 style="margin: 0 0 8px 0; font-size: 12px;">✅ Connected Successfully!</h4>
          <p style="margin: 4px 0; font-size: 11px;"><strong>Ticket:</strong> #${ticket.number}</p>
          <p style="margin: 4px 0; font-size: 11px;"><strong>Customer:</strong> ${customer.fname} ${customer.lname}</p>
          <p style="margin: 4px 0; font-size: 11px;"><strong>Email:</strong> ${customer.email}</p>
        </div>
        
        <div style="background: #fff9e6; padding: 12px; border-radius: 4px; border-left: 3px solid #f0b90b;">
          <h4 style="margin: 0 0 8px 0; font-size: 12px;">🎯 Next Steps</h4>
          <p style="margin: 0; font-size: 11px;">Ready to add conversation analysis and OpenAI evaluation!</p>
        </div>
      </div>
    `;
    
    res.json({ html });

  } catch (error) {
    console.error('Error:', error);
    res.json({
      html: `
        <div style="padding: 20px; font-family: Arial, sans-serif;">
          <h3>📊 Response Evaluator</h3>
          <p style="color: red;">Error: ${error.message}</p>
        </div>
      `
    });
  }
});

// Test endpoint
app.get('/widget', (req, res) => {
  res.send(`
    <div style="padding: 20px; font-family: Arial, sans-serif;">
      <h3>📊 Response Evaluator</h3>
      <p>Simple server running! Help Scout calls POST /</p>
      <p>Time: ${new Date().toISOString()}</p>
    </div>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Simple working server running on 0.0.0.0:${PORT}`);
});