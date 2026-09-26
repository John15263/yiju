import { check, fields, id, text } from './validation.mjs';

export class Freewrites {
  constructor(store) {
    this.store = store;
  }
  save(body) {
    fields(body, ['id', 'text', 'started_at', 'finished_at'], ['id', 'text', 'started_at', 'finished_at']);
    id(body.id); text(body.text, 20000); text(body.started_at, 40); text(body.finished_at, 40);
    const start = Date.parse(body.started_at), end = Date.parse(body.finished_at);
    check(Number.isFinite(start) && Number.isFinite(end) && end >= start, 'Invalid writing times');
    const record = { id: body.id, text: body.text, started_at: body.started_at, finished_at: body.finished_at };
    const previous = this.store.freewrite(record.id);
    if (previous) {
      check(Object.keys(record).every(key => previous[key] === record[key]), 'Writing ID reused', 409);
      return { ...previous, duplicate: true };
    }
    record.saved_at = new Date().toISOString();
    this.store.saveFreewrite(record);
    return record;
  }
}
