/**
 * Cloudflare Worker — Notion Update Form backend
 *
 * Receives form submissions from the public HTML form (GitHub Pages) and
 * forwards them to the Notion API.
 *
 * Endpoints:
 *   POST /api/save        — create a new row in 전략과제 업데이트 이력
 *
 * Required environment variables (set via `wrangler secret`):
 *   NOTION_TOKEN                    — Notion integration token (secret)
 *   STATUS_UPDATES_DATA_SOURCE_ID   — data source UUID
 *   INITIATIVES_DATA_SOURCE_ID      — data source UUID for 전략과제
 *   EXECUTIVES_DATA_SOURCE_ID       — data source UUID for 임원 리스트
 *   ALLOWED_ORIGIN                  — your GitHub Pages origin (e.g. https://dataagentkim-cpu.github.io)
 *                                     or "*" to allow any origin (less safe)
 */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2025-09-03';

// Property names — adjust if your Notion schema uses different names.
const SU_PROP_TITLE = '전략과제명';        // title column on Status Updates (used to be 전략과제 명)
const SU_PROP_SUMMARY = '요약제목';
const SU_PROP_CONTENT = '상세내용';
const SU_PROP_DATE = '작성일자';
const SU_PROP_AUTHOR = '작성자';
const SU_PROP_INITIATIVE = '전략과제 명 1';
const EX_PROP_NAME = '성명';
const INIT_PROP_NAME = '전략과제명';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (url.pathname === '/api/save' && request.method === 'POST') {
      return jsonResponse(await handleSave(request, env), env);
    }

    if (url.pathname === '/api/health') {
      return jsonResponse({ ok: true, time: new Date().toISOString() }, env);
    }

    return jsonResponse({ error: 'Not found' }, env, 404);
  },
};

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(body, env, status = 200) {
  return new Response(JSON.stringify(body), {
    status: typeof body.error === 'string' && status === 200 ? 400 : status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(env),
    },
  });
}

async function notion(path, init, env) {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init && init.headers),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { _raw: text }; }
  if (!res.ok) {
    const msg = data.message || data._raw || res.statusText;
    throw new Error(`Notion ${path} ${res.status}: ${msg}`);
  }
  return data;
}

async function findPageByTitle(dataSourceId, titlePropName, query, env) {
  if (!query) return null;
  const trimmed = query.trim();
  if (!trimmed) return null;
  const res = await notion(`/data_sources/${dataSourceId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: {
        property: titlePropName,
        title: { contains: trimmed },
      },
      page_size: 5,
    }),
  }, env);
  const results = res.results || [];
  if (results.length === 0) return null;
  // Prefer exact match on title
  for (const p of results) {
    const t = readTitle(p, titlePropName);
    if (t === trimmed) return p;
  }
  return results[0];
}

function readTitle(page, propName) {
  const prop = (page.properties || {})[propName];
  if (!prop || prop.type !== 'title') return '';
  return (prop.title || []).map((s) => s.plain_text || '').join('');
}

async function handleSave(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return { error: '본문이 올바른 JSON이 아닙니다.' }; }

  const initiative = (body.initiative || '').trim();
  const summary = (body.summary || '').trim();
  const content = (body.content || '').trim();
  const dateStr = (body.date || '').trim();
  const author = (body.author || '').trim();

  if (!initiative) return { error: '전략과제명을 입력하세요.' };
  if (!summary)    return { error: '요약 제목을 입력하세요.' };
  if (!author)     return { error: '작성자(이름)를 입력하세요.' };

  const warnings = [];

  // Lookup initiative
  let initiativePage = null;
  try {
    initiativePage = await findPageByTitle(env.INITIATIVES_DATA_SOURCE_ID, INIT_PROP_NAME, initiative, env);
  } catch (e) {
    warnings.push(`전략과제 조회 실패: ${e.message}`);
  }
  if (!initiativePage) {
    warnings.push(`'${initiative}' 와 매칭되는 전략과제를 못 찾아 관계는 비웠습니다.`);
  }

  // Lookup author (executive)
  let authorPage = null;
  try {
    authorPage = await findPageByTitle(env.EXECUTIVES_DATA_SOURCE_ID, EX_PROP_NAME, author, env);
  } catch (e) {
    warnings.push(`작성자 조회 실패: ${e.message}`);
  }
  if (!authorPage) {
    warnings.push(`'${author}' 와 매칭되는 임원을 못 찾아 작성자는 비웠습니다.`);
  }

  // Construct properties
  const properties = {
    [SU_PROP_TITLE]: {
      title: [{ text: { content: `${initiative} - ${summary}` } }],
    },
    [SU_PROP_SUMMARY]: {
      rich_text: [{ text: { content: summary } }],
    },
  };
  if (content) {
    properties[SU_PROP_CONTENT] = {
      rich_text: [{ text: { content } }],
    };
  }
  if (dateStr) {
    properties[SU_PROP_DATE] = { date: { start: dateStr } };
  }
  if (initiativePage) {
    properties[SU_PROP_INITIATIVE] = { relation: [{ id: initiativePage.id }] };
  }
  if (authorPage) {
    properties[SU_PROP_AUTHOR] = { relation: [{ id: authorPage.id }] };
  }

  // Create page
  const created = await notion('/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { type: 'data_source_id', data_source_id: env.STATUS_UPDATES_DATA_SOURCE_ID },
      properties,
    }),
  }, env);

  return {
    ok: true,
    page_id: created.id,
    url: created.url,
    warnings,
  };
}
