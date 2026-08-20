import { createClient } from '@supabase/supabase-js';
import yaml from 'js-yaml';

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    
    const supabaseUrl = env.SUPABASE_URL;
    const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
    const adminPassword = env.ADMIN_PASSWORD || 'admin123';
    
    if (!supabaseUrl || !supabaseKey) {
        return new Response(JSON.stringify({ error: "Supabase config missing" }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    
    const supabase = createClient(supabaseUrl, supabaseKey);
    
    const jsonResponse = (data, status = 200) => {
        return new Response(JSON.stringify(data), {
            status,
            headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Allow-Methods': '*'
            }
        });
    };

    if (method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Allow-Methods': '*'
            }
        });
    }

    try {
        if (path === '/api/verify' && method === 'POST') {
            const { password } = await request.json();
            return jsonResponse({ valid: password === adminPassword });
        }
        
        if (path === '/api/health' && method === 'GET') {
            const status = {
                supabaseUrlSet: !!supabaseUrl,
                supabaseKeySet: !!supabaseKey,
                databaseConnection: false,
                error: null,
                datasetCount: 0
            };
            try {
                const { count, error } = await supabase
                    .from('datasets')
                    .select('*', { count: 'exact', head: true });
                if (error) throw error;
                status.databaseConnection = true;
                status.datasetCount = count || 0;
            } catch (err) {
                status.error = err.message;
            }
            return jsonResponse(status);
        }
        
        if (path === '/api/datasets' && method === 'GET') {
            const { data, error } = await supabase
                .from('datasets')
                .select('name, count')
                .order('name', { ascending: true });
                
            if (error) throw error;
            return jsonResponse(data || []);
        }
        
        if (path.startsWith('/api/dataset/') && method === 'GET') {
            const filename = decodeURIComponent(path.replace('/api/dataset/', ''));
            const safeName = filename.split('/').pop();
            
            const { data, error } = await supabase
                .from('datasets')
                .select('questions')
                .eq('name', safeName)
                .single();
                
            if (error) {
                if (error.code === 'PGRST116') {
                    return jsonResponse({ error: 'Dataset not found' }, 404);
                }
                throw error;
            }
            return jsonResponse(data.questions);
        }
        
        if (path === '/api/upload' && method === 'POST') {
            const { password, filename, content } = await request.json();
            if (!password || password !== adminPassword) {
                return jsonResponse({ error: 'Unauthorized: Invalid password' }, 401);
            }
            if (!filename || !content) {
                return jsonResponse({ error: 'Filename and content are required' }, 400);
            }
            
            const ext = filename.split('.').pop().toLowerCase();
            if (!['json', 'yaml', 'yml'].includes(ext)) {
                return jsonResponse({ error: 'Invalid extension' }, 400);
            }
            
            let parsed = null;
            if (ext === 'yaml' || ext === 'yml') {
                parsed = yaml.load(content);
            } else if (ext === 'json') {
                parsed = JSON.parse(content);
            }
            
            if (!parsed) {
                return jsonResponse({ error: 'Empty file contents' }, 400);
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
                return jsonResponse({ error: 'Invalid document structure: no valid questions array found' }, 400);
            }
            
            const safeName = filename.split('/').pop();
            
            const { error } = await supabase
                .from('datasets')
                .upsert(
                    { name: safeName, count: questions.length, questions: parsed },
                    { onConflict: 'name' }
                );
                
            if (error) throw error;
            return jsonResponse({ success: true, name: safeName, count: questions.length });
        }
        
        if (path === '/api/delete' && method === 'POST') {
            const { password, filename } = await request.json();
            if (!password || password !== adminPassword) {
                return jsonResponse({ error: 'Unauthorized: Invalid password' }, 401);
            }
            if (!filename) {
                return jsonResponse({ error: 'Filename is required' }, 400);
            }
            
            const safeName = filename.split('/').pop();
            
            const { error } = await supabase
                .from('datasets')
                .delete()
                .eq('name', safeName);
                
            if (error) throw error;
            return jsonResponse({ success: true });
        }
        
        return jsonResponse({ error: 'Not found' }, 404);
        
    } catch (err) {
        return jsonResponse({ error: err.message }, 500);
    }
}
