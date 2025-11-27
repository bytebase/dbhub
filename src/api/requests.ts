import { Request as ExpressRequest, Response } from "express";
import { requestStore } from "../requests/index.js";

/**
 * GET /api/requests
 * GET /api/requests?source_id=prod_pg
 * List tracked requests, optionally filtered by source
 */
export function listRequests(req: ExpressRequest, res: Response): void {
  try {
    const sourceId = req.query.source_id as string | undefined;
    const requests = requestStore.getAll(sourceId);

    res.json({
      requests,
      total: requests.length,
    });
  } catch (error) {
    console.error("Error listing requests:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
}
