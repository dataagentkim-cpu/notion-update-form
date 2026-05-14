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
const SU_PROP_PRIORITY = '중요도'; // 대시보드 게시 / 과제이력 관리
const SU_PROP_FILES = '파일과 미디어';
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
      if (url.pathname === '/api/upload' && request.method === 'POST') {
        return jsonResponse(await handleUpload(request, env), env);
      }
      if (url.pathname === '/api/polish' && request.method === 'POST') {
        return jsonResponse(await handlePolish(request, env), env);
      }
      if (url.pathname === '/api/llm-key' && request.method === 'GET') {
        // 클라이언트가 Gemini를 직접 호출하기 위한 키 발급 (Origin 체크)
        const origin = request.headers.get('Origin') || '';
        if (env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN !== '*' && origin !== env.ALLOWED_ORIGIN) {
          return jsonResponse({ error: 'Forbidden origin' }, env, 403);
        }
        if (!env.GEMINI_API_KEY) return jsonResponse({ error: 'GEMINI_API_KEY 미설정' }, env, 500);
        return jsonResponse({ key: env.GEMINI_API_KEY, model: 'gemini-2.5-flash' }, env);
      }
      if (url.pathname === '/api/basic-tasks' && request.method === 'GET') {
        const dbId = url.searchParams.get('db');
        const execId = url.searchParams.get('executive_id') || '';
        return jsonResponse(await handleBasicTasks(dbId, execId, env), env);
      }
      if (url.pathname === '/api/save-basic' && request.method === 'POST') {
        return jsonResponse(await handleSaveBasic(request, env), env);
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
  // body가 string이면 UTF-8 바이트로 변환해 charset 명시
  let body = init && init.body;
  if (typeof body === 'string') {
    body = new TextEncoder().encode(body);
  }
  const res = await fetch(`${NOTION_API}${path}`, {
    ...init,
    body,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json; charset=utf-8',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
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
  const priority = (body.priority || '과제이력 관리').trim(); // 대시보드 게시 / 과제이력 관리 (디폴트 후자)
  const fileUploads = Array.isArray(body.file_uploads) ? body.file_uploads : []; // [{id,name}]

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

  const initiativeUrl = `https://www.notion.so/${initiativeId.replace(/-/g, '')}`;
  const properties = {
    [SU_PROP_TITLE]: {
      title: [{
        text: {
          content: initiativeName || '전략과제',
          link: { url: initiativeUrl },
        },
      }],
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
  if (['대시보드 게시','과제이력 관리'].includes(priority)) {
    properties[SU_PROP_PRIORITY] = { select: { name: priority } };
  }
  if (fileUploads.length > 0) {
    properties[SU_PROP_FILES] = {
      files: fileUploads.map((f) => ({
        type: 'file_upload',
        file_upload: { id: f.id },
        name: f.name || 'upload',
      })),
    };
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

// 기본과제 업데이트 이력 DB 컬럼
const BH_PROP_TITLE = '제목';
const BH_PROP_REPORTER = '작성자'; // (구버전: '보고자')
const BH_PROP_DATE = '작성일자';
const BH_PROP_CONTENT = '상세내용';
const BH_PROP_TASK = '기본과제';

// 기본과제 DB에서 임원과 연결된 relation 속성 후보 (있는 만큼 OR로 매칭)
const BASIC_OWNER_PROP_CANDIDATES = ['담당 임원', '담당임원', '참여 임원', '참여임원'];

// page_id / database_id / data_source_id 어느 거든 받아서 진짜 data_source_id 반환
async function resolveDataSourceId(idOrSlug, env) {
  if (!idOrSlug) throw new Error('ID 없음');
  // 1) data_source 직접 시도
  try { await notion(`/data_sources/${idOrSlug}`, {}, env); return idOrSlug; } catch {}
  // 2) database 시도 → data_sources 배열에서 첫 항목
  try {
    const db = await notion(`/databases/${idOrSlug}`, {}, env);
    if (db.data_sources?.length) return db.data_sources[0].id;
  } catch {}
  // 3) page 시도 → 자식 블록에서 child_database 찾기
  try {
    const children = await notion(`/blocks/${idOrSlug}/children`, {}, env);
    for (const b of children.results || []) {
      if (b.type === 'child_database') {
        const db = await notion(`/databases/${b.id}`, {}, env);
        if (db.data_sources?.length) return db.data_sources[0].id;
      }
    }
  } catch {}
  throw new Error(`'${idOrSlug}' 에서 데이터소스를 찾을 수 없습니다 (페이지·DB 모두 시도). 통합 권한 확인 필요.`);
}

async function handleBasicTasks(dbOrPageId, executiveId, env) {
  if (!dbOrPageId) return { error: 'db 파라미터가 필요합니다 (?db=<page_id 또는 data_source_id>).' };

  let dataSourceId;
  try {
    dataSourceId = await resolveDataSourceId(dbOrPageId, env);
  } catch (e) {
    return { error: e.message };
  }

  // 임원별 개인 DB의 title 속성명 + 보유한 owner relation 속성 자동 감지
  let titleProp = null;
  const ownerProps = [];
  try {
    const ds = await notion(`/data_sources/${dataSourceId}`, {}, env);
    for (const [k, v] of Object.entries(ds.properties || {})) {
      if (v.type === 'title') titleProp = titleProp || k;
      if (v.type === 'relation' && BASIC_OWNER_PROP_CANDIDATES.includes(k)) ownerProps.push(k);
    }
  } catch (e) {
    return { error: `기본과제 DB 스키마 조회 실패: ${e.message}` };
  }
  if (!titleProp) return { error: '제목(title) 속성을 찾을 수 없습니다.' };

  // executive_id 주어졌고 owner relation 속성이 있으면 필터링
  const query = { sorts: [{ property: titleProp, direction: 'ascending' }] };
  if (executiveId && ownerProps.length > 0) {
    query.filter = ownerProps.length === 1
      ? { property: ownerProps[0], relation: { contains: executiveId } }
      : { or: ownerProps.map((p) => ({ property: p, relation: { contains: executiveId } })) };
  }

  let pages;
  try {
    pages = await queryAll(dataSourceId, query, env);
  } catch (e) {
    return { error: `기본과제 조회 실패: ${e.message}` };
  }

  const tasks = pages
    .map((p) => ({ id: p.id, name: readTitle(p, titleProp) }))
    .filter((t) => t.name);
  return { tasks, filtered_by: ownerProps, executive_filter: executiveId ? 'applied' : 'none' };
}

async function handleSaveBasic(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return { error: '본문이 올바른 JSON이 아닙니다.' }; }

  const taskId = (body.task_id || '').trim();
  const taskName = (body.task_name || '').trim();
  const authorId = (body.author_id || '').trim();
  const summary = (body.summary || '').trim();
  const content = (body.content || '').trim();
  const dateStr = (body.date || '').trim();

  if (!taskId)   return { error: '기본과제를 선택하세요.' };
  if (!authorId) return { error: '작성자(임원)를 선택하세요.' };
  if (!summary)  return { error: '제목을 입력하세요.' };

  // 제목은 업데이트 요약만. 기본과제 연결은 별도 relation으로 처리.
  const properties = {
    [BH_PROP_TITLE]: {
      title: [{ text: { content: summary } }],
    },
    [BH_PROP_REPORTER]: { relation: [{ id: authorId }] },
  };
  if (content) properties[BH_PROP_CONTENT] = { rich_text: [{ text: { content } }] };
  if (dateStr) properties[BH_PROP_DATE] = { date: { start: dateStr } };

  // 기본과제 relation 속성이 추가됐다면 함께 세팅 (없으면 fallback)
  const warnings = [];
  try {
    const created = await notion('/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent: { type: 'data_source_id', data_source_id: env.BASIC_HISTORY_DATA_SOURCE_ID },
        properties: { ...properties, [BH_PROP_TASK]: { relation: [{ id: taskId }] } },
      }),
    }, env);
    return { ok: true, page_id: created.id, url: created.url, warnings };
  } catch (e) {
    // '기본과제' relation 속성 미존재 → 제거하고 재시도
    if (String(e.message).includes('기본과제') || String(e.message).includes('property') || String(e.message).includes('validation_error')) {
      try {
        const created = await notion('/pages', {
          method: 'POST',
          body: JSON.stringify({
            parent: { type: 'data_source_id', data_source_id: env.BASIC_HISTORY_DATA_SOURCE_ID },
            properties,
          }),
        }, env);
        warnings.push(`'${BH_PROP_TASK}' relation 속성이 이력 DB에 없어 과제 직접 연결 없이 저장됨 (제목에 과제명 prefix로 표시)`);
        return { ok: true, page_id: created.id, url: created.url, warnings };
      } catch (e2) {
        return { error: `저장 실패: ${e2.message}` };
      }
    }
    return { error: `저장 실패: ${e.message}` };
  }
}

async function handleUpload(request, env) {
  // 클라이언트가 보낸 multipart/form-data 파일을 노션 file_upload API로 forward
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file || typeof file === 'string') return { error: 'file 필드 누락' };
    const fileName = file.name || 'upload';

    // 1) file_upload 객체 생성
    const createRes = await fetch(`${NOTION_API}/file_uploads`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filename: fileName }),
    });
    const created = await createRes.json();
    if (!createRes.ok) return { error: `file_upload 생성 실패: ${created.message || createRes.status}` };

    // 2) send 엔드포인트로 파일 데이터 업로드
    const sendForm = new FormData();
    sendForm.append('file', file, fileName);
    const sendRes = await fetch(`${NOTION_API}/file_uploads/${created.id}/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
      },
      body: sendForm,
    });
    const sent = await sendRes.json();
    if (!sendRes.ok) return { error: `file_upload 전송 실패: ${sent.message || sendRes.status}` };

    return { ok: true, id: created.id, name: fileName };
  } catch (e) {
    return { error: `업로드 처리 실패: ${e.message}` };
  }
}

async function handlePolish(request, env) {
  if (!env.GEMINI_API_KEY) {
    return { error: 'AI 기능이 설정되지 않았습니다 (GEMINI_API_KEY 시크릿 누락).' };
  }

  let body;
  try { body = await request.json(); }
  catch { return { error: '본문이 올바른 JSON이 아닙니다.' }; }

  const summary = (body.summary || '').trim();
  const content = (body.content || '').trim();
  if (!summary && !content) return { error: '다듬을 내용을 입력하세요.' };

  // 입력 길이 캡 (어뷰즈 방지)
  const sLim = summary.slice(0, 500);
  const cLim = content.slice(0, 4000);

  const systemPrompt = `당신은 한화그룹 임원의 전략과제 진행 업데이트 메모를 정리하는 비서입니다.
임원이 작성한 거친 메모(요약 제목 + 상세 내용)를 받아 임원 보고체로 다듬어 JSON으로만 응답합니다.

규칙:
- 입력에 없는 수치/일정/조직명/금액을 새로 만들지 말 것. 사실 보존이 최우선.
- 격식체 사용 (~함, ~예정, ~검토, ~조치).
- summary: 30자 이내 핵심 한 줄. 핵심 명사구 + 동사 형태.
- content: 자연스러운 단락 또는 짧은 불릿 (3~5줄). 마크다운 사용 가능.
- 모호한 표현은 명확히, 중복은 제거.`;

  const userMsg = `[요약 제목 초안]\n${sLim || '(없음)'}\n\n[상세 내용 초안]\n${cLim || '(없음)'}`;

  let apiRes;
  try {
    apiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userMsg }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'object',
              properties: {
                summary: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['summary', 'content'],
            },
            maxOutputTokens: 600,
            temperature: 0.3,
          },
        }),
      }
    );
  } catch (e) {
    return { error: `Gemini API 호출 실패: ${e.message}` };
  }

  const data = await apiRes.json();
  if (!apiRes.ok) {
    return { error: `Gemini API 오류: ${data.error?.message || apiRes.status}` };
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Gemini가 responseSchema 무시한 경우 코드펜스 제거 시도
    try {
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return { error: 'AI 응답 파싱 실패', raw: text.slice(0, 500) };
    }
  }

  return {
    ok: true,
    summary: parsed.summary || summary,
    content: parsed.content || content,
  };
}
