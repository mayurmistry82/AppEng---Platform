import "server-only";

import { cache } from "react";
import { apiGet, type ApiResult } from "@/lib/api-server";
import type { JobDetailLike } from "@/lib/worksheet";

/**
 * Server-side job fetch (checklist 3.3).
 *
 * `getJob` is wrapped in React's `cache()` because BOTH the [id] layout (job
 * bar) and the worksheet page call it during the same render pass — the cache
 * is what makes that ONE `GET /api/job/{id}` per request instead of two.
 * Removing the wrapper doubles the backend traffic invisibly (asserted by
 * watching the uvicorn access log — Test 6 of the 3.3 prompt).
 *
 * Never throws: returns apiGet's ApiResult discriminated union unchanged.
 */

/**
 * Every jobs column plus path_label plus the twelve child ARRAYS. Indexed
 * loosely — the worksheet's pure logic (lib/worksheet.ts) treats every field
 * as untrusted anyway, so a tighter type here would only be theatre.
 */
export interface JobDetail extends JobDetailLike {
  job_id?: string;
  [key: string]: unknown;
}

export const getJob = cache(
  async (id: string): Promise<ApiResult<JobDetail>> =>
    apiGet<JobDetail>(`/api/job/${encodeURIComponent(id)}`),
);
