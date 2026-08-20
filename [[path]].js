/**
 * Cloudflare Pages Function — Anatomische Pro API
 * Uses raw fetch() to Supabase REST API (PostgREST).
 * No external npm imports needed — runs natively on Workers runtime.
 */

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const supabaseUrl = env.SUPABASE_URL;
    const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
    const adminPassword = env.ADMIN_PASSWORD || 'admin123';

    const jsonResponse = (data, status = 200) => {
        return new Response(JSON.stringify(data), {
            status,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
            }
        });
    };

    if (method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
            }
        });
    }

    if (!supabaseUrl || !supabaseKey) {
        return jsonResponse({ error: 'Supabase config missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Cloudflare Pages environment variables.' }, 500);
    }

    const restUrl = `${supabaseUrl}/rest/v1`;
    const supabaseHeaders = {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
    };

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
                const res = await fetch(`${restUrl}/datasets?select=name`, {
                    method: 'HEAD',
                    headers: {
                        ...supabaseHeaders,
                        'Prefer': 'count=exact'
                    }
                });
                if (!res.ok) {
                    const errText = await res.text();
                    throw new Error(`Supabase responded ${res.status}: ${errText}`);
                }
                status.databaseConnection = true;
                const contentRange = res.headers.get('content-range');
                if (contentRange) {
                    const match = contentRange.match(/\/(\d+)$/);
                    if (match) status.datasetCount = parseInt(match[1], 10);
                }
            } catch (err) {
                status.error = err.message;
            }
            return jsonResponse(status);
        }

        if (path === '/api/datasets' && method === 'GET') {
            const res = await fetch(`${restUrl}/datasets?select=name,count&order=name.asc`, {
                headers: supabaseHeaders
            });
            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Supabase error: ${errText}`);
            }
            const data = await res.json();
            return jsonResponse(data || []);
        }

        if (path.startsWith('/api/dataset/') && method === 'GET') {
            const filename = decodeURIComponent(path.replace('/api/dataset/', ''));
            const safeName = filename.split('/').pop();

            const res = await fetch(
                `${restUrl}/datasets?name=eq.${encodeURIComponent(safeName)}&select=questions&limit=1`,
                { headers: supabaseHeaders }
            );
            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Supabase error: ${errText}`);
            }
            const rows = await res.json();
            if (!rows || rows.length === 0) {
                return jsonResponse({ error: 'Dataset not found' }, 404);
            }
            return jsonResponse(rows[0].questions);
        }

        if (path === '/api/upload' && method === 'POST') {
            const body = await request.json();
            const { password, filename, content } = body;

            if (!password || password !== adminPassword) {
                return jsonResponse({ error: 'Unauthorized: Invalid password' }, 401);
            }
            if (!filename || !content) {
                return jsonResponse({ error: 'Filename and content are required' }, 400);
            }

            const ext = filename.split('.').pop().toLowerCase();
            if (!['json', 'yaml', 'yml'].includes(ext)) {
                return jsonResponse({ error: 'Invalid extension. Only JSON and YAML allowed.' }, 400);
            }

            let parsed = null;
            if (ext === 'json') {
                try {
                    parsed = JSON.parse(content);
                } catch (e) {
                    return jsonResponse({ error: 'Invalid JSON: ' + e.message }, 400);
                }
            } else {
                return jsonResponse({ error: 'YAML upload is not supported on Cloudflare. Please convert to JSON first.' }, 400);
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

            const res = await fetch(`${restUrl}/datasets`, {
                method: 'POST',
                headers: {
                    ...supabaseHeaders,
                    'Prefer': 'resolution=merge-duplicates,return=minimal'
                },
                body: JSON.stringify({
                    name: safeName,
                    count: questions.length,
                    questions: parsed
                })
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Supabase upsert error: ${errText}`);
            }

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

            const res = await fetch(
                `${restUrl}/datasets?name=eq.${encodeURIComponent(safeName)}`,
                {
                    method: 'DELETE',
                    headers: supabaseHeaders
                }
            );

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Supabase delete error: ${errText}`);
            }

            return jsonResponse({ success: true });
        }

        return jsonResponse({ error: 'Not found' }, 404);

    } catch (err) {
        return jsonResponse({ error: err.message || 'Internal server error' }, 500);
    }
}
