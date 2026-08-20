const express = require('express');
const cors = require('cors');
const path = require('path');
const yaml = require('js-yaml');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("==============================================================");
  console.error("CRITICAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars");
  console.error("are not set. Database integration will fail!");
  console.error("==============================================================");
}

const supabase = createClient(supabaseUrl, supabaseKey);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to verify admin password
function verifyAdmin(req, res, next) {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized: Invalid password' });
  }
  next();
}

// 1. Verify Password
app.post('/api/verify', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ valid: true });
  }
  return res.json({ valid: false });
});

// 1b. Health check endpoint to diagnose Supabase connectivity issues
app.get('/api/health', async (req, res) => {
  const status = {
    supabaseUrlSet: !!supabaseUrl,
    supabaseKeySet: !!supabaseKey,
    databaseConnection: false,
    error: null,
    datasetCount: 0
  };

  try {
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase URL or Key environment variables are missing');
    }
    // Try a simple count query to check DB connectivity
    const { count, error } = await supabase
      .from('datasets')
      .select('*', { count: 'exact', head: true });

    if (error) throw error;
    status.databaseConnection = true;
    status.datasetCount = count || 0;
  } catch (err) {
    status.error = err.message;
  }

  res.json(status);
});

// 2. Get list of all datasets (name and question count)
app.get('/api/datasets', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('datasets')
      .select('name, count')
      .order('name', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve datasets: ' + err.message });
  }
});

// 3. Get questions from a specific dataset
app.get('/api/dataset/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const safeName = path.basename(filename);

    const { data, error } = await supabase
      .from('datasets')
      .select('questions')
      .eq('name', safeName)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Dataset not found' });
      }
      throw error;
    }

    res.json(data.questions);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read dataset: ' + err.message });
  }
});

// 4. Upload/Save a new dataset (Admin Only)
app.post('/api/upload', verifyAdmin, async (req, res) => {
  try {
    const { filename, content } = req.body;
    if (!filename || !content) {
      return res.status(400).json({ error: 'Filename and content are required' });
    }

    const ext = path.extname(filename).toLowerCase();
    if (!['.json', '.yaml', '.yml'].includes(ext)) {
      return res.status(400).json({ error: 'Invalid file extension. Only JSON and YAML are allowed' });
    }

    // Parse content to check valid structure
    let parsed = null;
    if (ext === '.yaml' || ext === '.yml') {
      parsed = yaml.load(content);
    } else if (ext === '.json') {
      parsed = JSON.parse(content);
    }

    if (!parsed) {
      return res.status(400).json({ error: 'Empty file contents' });
    }

    let questions = [];
    if (Array.isArray(parsed)) {
      questions = parsed;
    } else if (typeof parsed === 'object') {
      const possibleKeys = ['multiple_choice', 'flashcards', 'questions', 'cards', 'short_answers', 'short_answer', 'quiz'];
      let found = false;
      possibleKeys.forEach(k => {
        if (Array.isArray(parsed[k])) {
          questions = questions.concat(parsed[k]);
          found = true;
        }
      });
      if (!found) {
        Object.values(parsed).forEach(val => {
          if (Array.isArray(val)) {
            questions = questions.concat(val);
          }
        });
      }
    }

    if (!questions || questions.length === 0) {
      return res.status(400).json({ error: 'Invalid document structure: no valid questions array found' });
    }

    const safeName = path.basename(filename);

    // Save/Upsert into Supabase datasets table
    const { data, error } = await supabase
      .from('datasets')
      .upsert(
        { name: safeName, count: questions.length, questions: parsed },
        { onConflict: 'name' }
      );

    if (error) throw error;

    res.json({ success: true, name: safeName, count: questions.length });
  } catch (err) {
    res.status(400).json({ error: 'Invalid format/error saving to database: ' + err.message });
  }
});

// 5. Delete a dataset (Admin Only)
app.post('/api/delete', verifyAdmin, async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }

    const safeName = path.basename(filename);

    const { error } = await supabase
      .from('datasets')
      .delete()
      .eq('name', safeName);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete dataset: ' + err.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`=============================================`);
    console.log(` Anatomische Pro is running online!`);
    console.log(` Port: ${PORT}`);
    console.log(` Mode: http://localhost:${PORT}`);
    console.log(` Database: Supabase PostgreSQL`);
    console.log(`=============================================`);
  });
}

module.exports = app;
