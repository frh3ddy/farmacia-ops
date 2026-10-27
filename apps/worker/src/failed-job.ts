type SaleJob = { id?: string; attemptsMade?: number; failedReason?: string; data?: any };

/** The Square payment id a sale job was queued for (job data is the webhook's `event.data`). */
export const paymentIdOf = (job: Pick<SaleJob, 'data'> | undefined): string | undefined => job?.data?.payload?.object?.payment?.id;

/**
 * What to log for a failed job: ids and the error, never the job data —
 * a sale job holds the Square payment (card details, buyer email).
 */
export function describeFailedJob(job: SaleJob, error?: Error) {
  return { id: job.id, paymentId: paymentIdOf(job), attemptsMade: job.attemptsMade, error: error?.message ?? job.failedReason };
}
