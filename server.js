const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.get('/', (req, res) => {
  res.send('BizForge Backend is Live!');
});

// Initialize Clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Middleware for API Key verification or Basic Auth if needed
const verifyUser = async (req, res, next) => {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(401).json({ error: 'Missing x-user-id header' });
  }
  req.userId = userId;
  next();
};

// 1. GENERATE AI CONTENT ENDPOINT
app.post('/api/v1/generate', verifyUser, async (req, res) => {
  try {
    const { businessId, toolType, promptInput } = req.body;

    if (!toolType || !promptInput) {
      return res.status(400).json({ error: 'toolType and promptInput are required' });
    }

    // Check user credits
    const { data: userCredit, error: creditErr } = await supabase
      .from('user_credits')
      .select('credits_balance')
      .eq('user_id', req.userId)
      .single();

    if (creditErr || !userCredit || userCredit.credits_balance < 1) {
      return res.status(402).json({ error: 'Insufficient credit balance' });
    }

    // Fetch Business Profile context if provided
    let businessContext = "";
    if (businessId) {
      const { data: biz } = await supabase
        .from('businesses')
        .select('*')
        .eq('id', businessId)
        .single();
      
      if (biz) {
        businessContext = `Business Name: ${biz.business_name}, Industry: ${biz.industry}, Target Audience: ${biz.target_audience}, Description: ${biz.description}`;
      }
    }

    // Build OpenAI Prompt
    const systemPrompt = `You are BizForge AI, an expert business consultant. Use the following business context if relevant:\n${businessContext}`;
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Tool: ${toolType}\nInput: ${promptInput}` }
      ],
      response_format: { type: "json_object" }
    });

    const aiOutput = JSON.parse(response.choices[0].message.content);

    // Deduct 1 credit using Supabase RPC or Direct Update
    await supabase
      .from('user_credits')
      .update({ credits_balance: userCredit.credits_balance - 1 })
      .eq('user_id', req.userId);

    // Record Generation Log
    await supabase.from('generations').insert({
      business_id: businessId || null,
      tool_type: toolType,
      prompt_input: promptInput,
      output_payload: aiOutput,
      credits_spent: 1
    });

    return res.status(200).json({
      success: true,
      remaining_credits: userCredit.credits_balance - 1,
      data: aiOutput
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
});

// 2. USER CREDITS ENDPOINT
app.get('/api/v1/user/credits', verifyUser, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_credits')
      .select('*')
      .eq('user_id', req.userId)
      .single();

    if (error && error.code === 'PGRST116') {
      // User doesn't exist in ledger, create initial row with 25 free credits
      const { data: newUser } = await supabase
        .from('user_credits')
        .insert({ user_id: req.userId, credits_balance: 25 })
        .select()
        .single();
      return res.status(200).json(newUser);
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BizForge Server running on port ${PORT}`);
});
