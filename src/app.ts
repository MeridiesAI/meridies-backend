import cors from "@fastify/cors";
import Fastify, { type FastifyError } from "fastify";
import { ZodError } from "zod";
import { corsOrigins, env, hasAnthropic, hasServiceRole, hasTwilio } from "./env.js";
import { HttpError } from "./lib/errors.js";
import rateLimitPlugin from "./plugins/rateLimit.js";
import supabaseAuth from "./plugins/supabaseAuth.js";
import { startSweepInterval } from "./lib/sweepSchedule.js";
import accountabilityRoutes from "./routes/accountability.js";
import aidRoutes from "./routes/aid.js";
import aiRoutes from "./routes/ai.js";
import authRoutes from "./routes/auth.js";
import blastRoutes from "./routes/blasts.js";
import chatRoutes from "./routes/chat.js";
import collegeRoutes from "./routes/colleges.js";
import deadlineRoutes from "./routes/deadlines.js";
import fileRoutes from "./routes/files.js";
import firmRoutes from "./routes/firms.js";
import healthRoutes from "./routes/health.js";
import intakeRoutes from "./routes/intake.js";
import accountRoutes from "./routes/account.js";
import collegeIntelRoutes from "./routes/collegeIntel.js";
import webhookRoutes from "./routes/webhooks.js";
import resourceRoutes from "./routes/resources.js";
import searchRoutes from "./routes/search.js";
import settingsRoutes from "./routes/settings.js";
import internalRoutes from "./routes/internal.js";
import integrationRoutes from "./routes/integrations.js";
import inviteRoutes from "./routes/invites.js";
import meetingRoutes from "./routes/meetings.js";
import notificationRoutes from "./routes/notifications.js";
import opportunityRoutes from "./routes/opportunities.js";
import preferenceRoutes from "./routes/preferences.js";
import recordRoutes from "./routes/records.js";
import reportRoutes from "./routes/reports.js";
import importRoutes from "./routes/imports.js";
import rosterRoutes from "./routes/roster.js";
import studentRoutes from "./routes/students.js";
import aiContextRoutes from "./routes/aiContext.js";
import taskRoutes from "./routes/tasks.js";
// v10 sync imports: foundations
// v10 sync imports: overview
import workItemRoutes from "./routes/workItems.js";
import pinRoutes from "./routes/pins.js";
import outcomeRoutes, { alumniRoutes } from "./routes/outcomes.js";
import referralRoutes from "./routes/referrals.js";
import overviewSummaryRoutes from "./routes/overviewSummaries.js";
// v10 sync imports: student-application
import applicationRoutes from "./routes/application.js";
import applicationAiRoutes from "./routes/applicationAi.js";
// v10 sync imports: student-aid-comms
import studentPageRoutes from "./routes/studentPage.js";
import studentAidRoutes from "./routes/studentAid.js";
import communicationRoutes from "./routes/communication.js";
// v10 sync imports: colleges-events
import collegeV10Routes from "./routes/collegesV10.js";
import collegeAiRoutes from "./routes/collegeAi.js";
import eventRoutes from "./routes/events.js";
// v10 sync imports: management-pipeline
import emailTemplateRoutes from "./routes/emailTemplates.js";
import managementRoutes from "./routes/management.js";
import pipelineRoutes from "./routes/pipeline.js";
// v10 sync imports: calendar-files-axis
import calendarRoutes from "./routes/calendar.js";
// SV Demo v2: the student view
import meRoutes from "./routes/me.js";
import profileUpdateRoutes from "./routes/profileUpdates.js";

export function buildApp() {
  const app = Fastify({
    logger: {
      // Query values are dropped from request logs: the OAuth callback carries
      // a live authorization code and state there, and nothing in a query
      // string is worth keeping in Railway's logs. Keys stay for debugging.
      serializers: {
        req(req) {
          const [path, query] = req.url.split("?", 2);
          const keys = query
            ? [...new URLSearchParams(query).keys()].map((k) => `${k}=…`).join("&")
            : "";
          return {
            method: req.method,
            url: keys ? `${path}?${keys}` : path,
            hostname: req.hostname,
            remoteAddress: req.ip,
          };
        },
      },
    },
    // Railway sits behind a proxy; without this every request looks like it
    // came from the same address and the per-IP limiter is useless.
    trustProxy: true,
    bodyLimit: 1_048_576,
    // A client whose base URL ends in "/" sends "//auth/me". Fastify treats
    // that as a distinct, unrouted path and 404s, which reads like the endpoint
    // is missing rather than like a config typo. Collapse them instead.
    ignoreDuplicateSlashes: true,
    ignoreTrailingSlash: true,
  });

  // Paged lists (GET /colleges/search) carry their total and next cursor in headers.
  app.register(cors, { origin: corsOrigins, credentials: true, exposedHeaders: ["X-Total-Count", "X-Next-Cursor"] });
  app.register(rateLimitPlugin);
  app.register(supabaseAuth);

  app.register(healthRoutes);
  app.register(authRoutes, { prefix: "/auth" });
  app.register(inviteRoutes, { prefix: "/invites" });
  app.register(studentRoutes, { prefix: "/students" });
  app.register(aiContextRoutes, { prefix: "/students" });
  app.register(deadlineRoutes, { prefix: "/deadlines" });
  app.register(recordRoutes);
  // Catalog reads (/colleges, /high-schools) sit at the root like recordRoutes.
  app.register(collegeRoutes);
  app.register(intakeRoutes, { prefix: "/intake" });
  app.register(aidRoutes, { prefix: "/aid" });
  app.register(accountabilityRoutes, { prefix: "/accountability" });
  app.register(taskRoutes, { prefix: "/tasks" });
  app.register(fileRoutes, { prefix: "/files" });
  app.register(blastRoutes, { prefix: "/blasts" });
  app.register(firmRoutes, { prefix: "/firms" });
  app.register(opportunityRoutes, { prefix: "/opportunities" });
  app.register(preferenceRoutes, { prefix: "/preference-cards" });
  app.register(meetingRoutes, { prefix: "/meetings" });
  app.register(notificationRoutes, { prefix: "/notifications" });
  app.register(integrationRoutes, { prefix: "/integrations" });
  app.register(reportRoutes, { prefix: "/reports" });
  app.register(rosterRoutes, { prefix: "/roster" });
  app.register(importRoutes, { prefix: "/imports" });
  app.register(aiRoutes, { prefix: "/ai" });
  app.register(chatRoutes, { prefix: "/chat" });
  // v10 sync routes: foundations
  // v10 sync routes: overview
  app.register(workItemRoutes, { prefix: "/work-items" });
  app.register(pinRoutes, { prefix: "/pins" });
  app.register(outcomeRoutes, { prefix: "/outcomes" });
  app.register(alumniRoutes, { prefix: "/alumni" });
  app.register(referralRoutes, { prefix: "/referrals" });
  app.register(overviewSummaryRoutes, { prefix: "/overview" });
  // v10 sync routes: student-application
  app.register(applicationRoutes, { prefix: "/application" });
  app.register(applicationAiRoutes, { prefix: "/application" });
  // v10 sync routes: student-aid-comms
  app.register(studentPageRoutes, { prefix: "/student-page" });
  app.register(studentAidRoutes, { prefix: "/student-aid" });
  app.register(communicationRoutes, { prefix: "/communication" });
  // v10 sync routes: colleges-events
  app.register(collegeV10Routes, { prefix: "/colleges" });
  app.register(collegeIntelRoutes, { prefix: "/colleges" });
  app.register(collegeAiRoutes, { prefix: "/ai" });
  app.register(eventRoutes, { prefix: "/events" });
  // v10 sync routes: management-pipeline
  app.register(pipelineRoutes, { prefix: "/pipeline" });
  app.register(managementRoutes, { prefix: "/management" });
  app.register(emailTemplateRoutes, { prefix: "/email-templates" });
  // v10 sync routes: calendar-files-axis
  app.register(calendarRoutes, { prefix: "/calendar" });
  // SV Demo v2 routes: the student view. profileUpdateRoutes sits at the root
  // because it also serves the counselor's /students/:id/profile-updates.
  app.register(meRoutes, { prefix: "/me" });
  app.register(profileUpdateRoutes);
  // Machine-to-machine (CRON_SECRET), not the app. See lib/sweepSchedule.ts.
  app.register(resourceRoutes, { prefix: "/resources" });
  app.register(searchRoutes, { prefix: "/search" });
  app.register(settingsRoutes, { prefix: "/settings" });
  app.register(accountRoutes, { prefix: "/account" });
  app.register(webhookRoutes, { prefix: "/webhooks" });
  app.register(internalRoutes, { prefix: "/internal" });
  startSweepInterval(app);

  app.addHook("onReady", async () => {
    if (!hasServiceRole) {
      app.log.warn(
        "SUPABASE_SERVICE_ROLE_KEY is not set: rate limits and AI quotas are " +
          "per-process only and reset on every deploy."
      );
    }
    if (!hasAnthropic) {
      app.log.warn("ANTHROPIC_API_KEY is not set: /ai/* will return 503.");
    }
    if (!hasTwilio) {
      app.log.warn(
        "Twilio is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and " +
          "TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID): SMS is recorded " +
          "as queued and not sent."
      );
    }
  });

  app.setErrorHandler((err: FastifyError | ZodError | HttpError, request, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Invalid request", details: err.flatten() });
    }
    if (err instanceof HttpError) {
      if (err.statusCode >= 500) request.log.error(err);
      return reply.code(err.statusCode).send({ error: err.message });
    }
    if ((err as FastifyError).validation) {
      return reply
        .code(400)
        .send({ error: "Invalid request", details: (err as FastifyError).validation });
    }

    const statusCode = (err as FastifyError).statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error(err);
      // Never leak internals — no stack traces, no key hints.
      return reply.code(500).send({ error: "Something went wrong on our end" });
    }
    return reply.code(statusCode).send({ error: err.message ?? "Request failed" });
  });

  return app;
}

export const isProduction = env.NODE_ENV === "production";
