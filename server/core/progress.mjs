import { normalizeSubject, subjectLabel } from './subjects.mjs';

function watchedSeconds(ranges) {
  let end = 0, total = 0;
  for (const [from, to] of ranges.sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, to - Math.max(end, from));
    end = Math.max(end, to);
  }
  return Math.floor(total);
}

export function studyProgress(db) {
  const courses = new Map();
  const captures = new Map();
  const makeCourse = (id, key, title, axis) => ({ id, key, title, axis: normalizeSubject(axis) || 'other', watched: 0, readCharacters:0, answered: 0, correct: 0, reviewed: 0, recentAt: 0, parts: [], concepts: [] });
  for (const row of db.prepare('SELECT id,title,axis,platform,external_id FROM courses ORDER BY created_at, id').all()) {
    const bvid = row.platform === 'bilibili' && row.external_id;
    const course = makeCourse(row.id, bvid || row.id, row.title, row.axis);
    courses.set(row.id, course);
    if (bvid) captures.set(bvid, course);
  }
  const parts = new Map();
  const importedParts = new Map(), sessionPages = new Map();
  for (const row of db.prepare("SELECT payload_json FROM events WHERE type IN ('capture.imported','capture.batch-prepared') AND json_valid(payload_json) ORDER BY rowid").all()) {
    const event = JSON.parse(row.payload_json);
    importedParts.set(`${event.bvid}:${event.page}`, event);
    sessionPages.set(event.sessionId, event.page);
  }
  for (const row of db.prepare("SELECT payload_json,created_at FROM events WHERE type IN ('capture.queued','capture.skipped') AND json_valid(payload_json)").all()) {
    const event = JSON.parse(row.payload_json);
    if (!event.bvid || !Number.isInteger(event.page) || !Array.isArray(event.ranges)) continue;
    let course = captures.get(event.bvid);
    if (!course) {
      course = makeCourse(null, event.bvid, event.title || event.bvid, event.axis);
      captures.set(event.bvid, course);
    }
    const key = `${event.bvid}:${event.page}`;
    if (!parts.has(key)) parts.set(key, { course, page: event.page, ranges: [] });
    const part = parts.get(key);
    for (const range of event.ranges) {
      if (!Array.isArray(range) || range.length !== 2) continue;
      const [from, to] = range;
      if (Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to > from) part.ranges.push(range);
    }
    course.recentAt = Math.max(course.recentAt, event.endedAt || row.created_at);
  }
  for (const [key, part] of parts) {
    const seconds = watchedSeconds(part.ranges);
    if (seconds) {
      part.course.watched += seconds;
      const imported = importedParts.get(key);
      const duration = Number.isFinite(imported?.duration) && imported.duration > 0 ? Math.floor(imported.duration) : null;
      part.course.parts.push({ page: part.page, title: imported?.partTitle || null, seconds, duration });
    }
  }
  for(const row of db.prepare("SELECT payload_json,created_at FROM events WHERE type='reading.finished' AND json_valid(payload_json)").all()){
    const event=JSON.parse(row.payload_json),course=courses.get(event.courseId);if(!course||!event.sessionId)continue;
    course.readCharacters+=event.characters||0;course.watched+=event.seconds||0;course.recentAt=Math.max(course.recentAt,row.created_at);
  }
  const attempts = db.prepare(`SELECT s.course_id, COUNT(*) answered,
      SUM(CASE WHEN a.correct=1 THEN 1 WHEN a.graded_by LIKE 'model:%' AND json_valid(a.rubric_json)
        THEN json_type(a.rubric_json,'$.passed')='true' ELSE 0 END) correct,
      SUM(CASE WHEN x.reason='objective:review-correct' THEN 1 ELSE 0 END) reviewed, MAX(a.created_at) recentAt
    FROM answers a JOIN cards k ON k.id=a.card_id AND k.discarded=0
    JOIN segments g ON g.id=k.segment_id JOIN sessions s ON s.id=g.session_id
    LEFT JOIN events e ON e.dedupe_key='answer:' || a.card_id || ':' || a.session_id
    LEFT JOIN xp_ledger x ON x.event_id=e.id GROUP BY s.course_id`).all();
  for (const row of attempts) {
    const course = courses.get(row.course_id);
    course.answered = row.answered;
    course.correct = row.correct || 0;
    course.reviewed = row.reviewed;
    course.recentAt = Math.max(course.recentAt, row.recentAt);
  }
  for (const course of captures.values()) course.parts.sort((a, b) => a.page - b.page);
  const all = [...new Set([...courses.values(), ...captures.values()])].filter((c) => c.axis !== '待识别' && (c.watched || c.readCharacters || c.answered));
  const studied = new Map(all.filter((c) => c.id).map((c) => [c.id, c]));
  const practiced = new Set(db.prepare(`SELECT DISTINCT g.session_id id FROM answers a
    JOIN cards k ON k.id=a.card_id AND k.discarded=0 JOIN segments g ON g.id=k.segment_id`).all().map((row) => row.id));
  const summarized = new Set();
  for (const row of db.prepare(`SELECT s.id sessionId,s.course_id courseId,e.payload_json FROM events e
    JOIN sessions s ON s.id=CASE WHEN json_valid(e.payload_json) THEN json_extract(e.payload_json,'$.sessionId') END
    WHERE e.type='lesson.summarized' ORDER BY e.rowid DESC`).all()) {
    const course = studied.get(row.courseId);
    if (!course || summarized.has(row.sessionId) || !(sessionPages.has(row.sessionId) || practiced.has(row.sessionId))) continue;
    summarized.add(row.sessionId);
    const page = sessionPages.get(row.sessionId) || null;
    const ideas = JSON.parse(row.payload_json).summary?.coreIdeas;
    if (!Array.isArray(ideas)) continue;
    for (const idea of ideas) {
      if (typeof idea?.title !== 'string') continue;
      if (!course.concepts.some((concept) => concept.title === idea.title && concept.page === page)) {
        course.concepts.push({ title: idea.title, meaning: idea.meaning, page });
      }
    }
  }
  const groups = new Map();
  for (const course of all) {
    if (!groups.has(course.axis)) groups.set(course.axis, []);
    groups.get(course.axis).push(course);
  }
  return [...groups].map(([axis, list]) => {
    list.sort((a, b) => b.recentAt - a.recentAt);
    const totals = { watched: 0, readCharacters:0, answered: 0, correct: 0, reviewed: 0 };
    for (const c of list) for (const key of Object.keys(totals)) totals[key] += c[key];
    const stage = totals.reviewed ? 4 : totals.correct ? 3 : totals.answered ? 2 : totals.watched || totals.readCharacters ? 1 : 0;
    return { axis, name: subjectLabel(axis), ...totals, stage, courses: list };
  });
}
