-- When the upstream video task was created (set by setJobPolling, exactly
-- once per job). The 30-minute cap used to be measured from Job.createdAt,
-- which includes the queue wait: a job claimed 29 minutes after submit created
-- its task and was killed one minute later, so the provider was billed for a
-- task nothing would ever collect. Two clocks now, one column: before the task
-- exists the cap bounds the queue wait (and refuses before billing), after it
-- exists the cap follows the task.
ALTER TABLE "Job" ADD COLUMN "taskCreatedAt" TIMESTAMP(3);
