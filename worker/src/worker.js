/**
 * Cloudflare Worker — Notion Update Form backend
 *
 * Endpoints:
 *   GET  /api/bootstrap                       — 임원 리스트 반환
 *   GET  /api/initiatives?executive_id=<id>   — 해당 임원이 담당/참여 중인 전략과제 반환
 *   POST /api/save                            — 전략과제 업데이트 이력에 1행 생성
 *   GET  /api/health                          — 헬스 체크
 *
 * Required env (wrangler.toml [vars] / wrangler secret):
 *   NOTION_TOKEN                    — Notion integration token (secret)
 *   STATUS_UPDATES_DATA_SOURCE_ID   — 업데이트 이력 data source UUID
 *   INITIATIVES_DATA_SOURCE_ID      — 전략과제 data source UUID
 *   EXECUTIVES_DATA_SOURCE_ID       — 임원 리스트 data source UUID
 *   ALLOWED_ORIGIN                  — GitHub Pages origin
 */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2025-09-03';

// Property names — adjust if your Notion schema uses different names.
const SU_PROP_TITLE = '전략과제명';
const SU_PROP_SUMMARY = '요약제목';
const SU_PROP_CONTENT = '상세내용';
const SU_PROP_DATE = '작성일자';
const SU_PROP_AUTHOR = '작성자';
const SU_PROP_INITIATIVE = '전략과제 명 1';
const SU_PROP_DAEBUNRYU = '전략과제_대분류'; // 대시보드 그룹핑용 (전략과제에서 복사)
const EX_PROP_NAME = '성명';
const INIT_PROP_NAME = '전략과제명';
const INIT_PROP_DAEBUNRYU = '전략과제_대분류';
// 전략과제 DB에서 임원과 연결된 relation 속성 후보들 (둘 중 하나라도 매칭되면 본인 과제로 인정)
const INIT_PROP_OWNER_CANDIDATES = ['담당 임원', '참여 임원'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      if (url.pathname === '/api/bootstrap' && request.method === 'GET') {
        return jsonResponse(await handleBootstrap(env), env);
      }
      if (url.pathname === '/api/initiatives' && request.method === 'GET') {
        const executiveId = url.searchParams.get('executive_id');
        return jsonResponse(await handleInitiatives(executiveId, env), env);
      }
      if (url.pathname === '/api/save' && request.method === 'POST') {
        return jsonResponse(await handleSave(request, env), env);
      }
      if (url.pathname === '/api/health') {
        return jsonResponse({ ok: true, time: new Date().toISOString() }, env);
      }
    } catch (e) {
      return jsonResponse({ error: e.message || String(e) }, env, 500);
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

function readTitle(page, propName) {
  const prop = (page.properties || {})[propName];
  if (!prop || prop.type !== 'title') return '';
  return (prop.title || []).map((s) => s.plain_text || '').join('');
}

async function queryAll(dataSourceId, body, env) {
  const results = [];
  let cursor;
  do {
    const payload = { ...body, page_size: 100 };
    if (cursor) payload.start_cursor = cursor;
    const res = await notion(`/data_sources/${dataSourceId}/query`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }, env);
    results.push(...(res.results || []));
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return results;
}

async function handleBootstrap(env) {
  const pages = await queryAll(env.EXECUTIVES_DATA_SOURCE_ID, {
    sorts: [{ property: EX_PROP_NAME, direction: 'ascending' }],
  }, env);
  const executives = pages
    .map((p) => ({ id: p.id, name: readTitle(p, EX_PROP_NAME) }))
    .filter((e) => e.name);
  return { executives };
}

async function handleInitiatives(executiveId, env) {
  if (!executiveId) return { error: 'executive_id 가 필요합니다.' };

  // 담당임원 또는 참여임원 relation 중 어느 한쪽이라도 해당 임원을 포함하면 본인 과제
  const orFilters = INIT_PROP_OWNER_CANDIDATES.map((prop) => ({
    property: prop,
    relation: { contains: executiveId },
  }));

  let pages;
  try {
    pages = await queryAll(env.INITIATIVES_DATA_SOURCE_ID, {
      filter: { or: orFilters },
      sorts: [{ property: INIT_PROP_NAME, direction: 'ascending' }],
    }, env);
  } catch (e) {
    // 두 속성 중 하나가 없는 경우를 대비해 fallback (각각 단독으로 시도)
    pages = [];
    const seen = new Set();
    for (const prop of INIT_PROP_OWNER_CANDIDATES) {
      try {
        const part = await queryAll(env.INITIATIVES_DATA_SOURCE_ID, {
          filter: { property: prop, relation: { contains: executiveId } },
          sorts: [{ property: INIT_PROP_NAME, direction: 'ascending' }],
        }, env);
        for (const p of part) {
          if (!seen.has(p.id)) { seen.add(p.id); pages.push(p); }
        }
      } catch { /* 속성 미존재 등은 무시 */ }
    }
  }

  const initiatives = pages
    .map((p) => ({ id: p.id, name: readTitle(p, INIT_PROP_NAME) }))
    .filter((i) => i.name);
  return { initiatives };
}

async function handleSave(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return { error: '본문이 올바른 JSON이 아닙니다.' }; }

  const initiativeId = (body.initiative_id || '').trim();
  const authorId = (body.author_id || '').trim();
  const initiativeName = (body.initiative_name || '').trim();
  const authorName = (body.author_name || '').trim();
  const summary = (body.summary || '').trim();
  const content = (body.content || '').trim();
  const dateStr = (body.date || '').trim();

  if (!initiativeId) return { error: '전략과제를 선택하세요.' };
  if (!authorId)    return { error: '작성자(임원)를 선택하세요.' };
  if (!summary)     return { error: '요약 제목을 입력하세요.' };

  const warnings = [];

  // 선택한 전략과제의 대분류를 가져와 함께 세팅 (대시보드 그룹핑 위해 필요)
  let daebunRelation = [];
  try {
    const initPage = await notion(`/pages/${initiativeId}`, {}, env);
    const rel = initPage.properties?.[INIT_PROP_DAEBUNRYU]?.relation || [];
    daebunRelation = rel.map((r) => ({ id: r.id }));
  } catch (e) {
    warnings.push(`전략과제 대분류 조회 실패: ${e.message}`);
  }

  const properties = {
    [SU_PROP_TITLE]: {
      title: [{ text: { content: `${initiativeName || '전략과제'} - ${summary}` } }],
    },
    [SU_PROP_SUMMARY]: {
      rich_text: [{ text: { content: summary } }],
    },
    [SU_PROP_INITIATIVE]: { relation: [{ id: initiativeId }] },
    [SU_PROP_AUTHOR]: { relation: [{ id: authorId }] },
  };
  if (daebunRelation.length > 0) {
    properties[SU_PROP_DAEBUNRYU] = { relation: daebunRelation };
  }
  if (content) {
    properties[SU_PROP_CONTENT] = { rich_text: [{ text: { content } }] };
  }
  if (dateStr) {
    properties[SU_PROP_DATE] = { date: { start: dateStr } };
  }

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
