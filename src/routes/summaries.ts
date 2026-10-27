import { Hono } from 'hono'
import { getDroughtSummary } from '../db/queries/summaries'
import { ok } from '../lib/response'
import { getRlsFromContext } from '../middleware/auth'

export const summariesRouter = new Hono()

summariesRouter.get('/drought', async (c) => {
  const rls = getRlsFromContext(c)
  const summary = await getDroughtSummary(rls)
  return ok(c, summary)
})
