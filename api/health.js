import { withVercelContext } from './_lib/context.js';
import { ok, readJSON } from './_lib/core.js';
async function handler() { return ok({service:'ICANT Master',time:new Date().toISOString(),storage:!!(await readJSON('config/settings',{}))}); }

export default { fetch: (request) => withVercelContext(request, handler) };
