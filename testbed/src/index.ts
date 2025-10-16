import { endInstrumentSession, startInstrumentSession, Eval, EvalTypes } from '@workspace/instrument';
import { runMockServiceDecorated } from './workflow';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import http from 'http';

async function main() {
    try {
        const sessionId = randomUUID();
        const project = 'instrumentMeetingInsight';
        const session = `meeting_insight_${sessionId}`;
        const units = startInstrumentSession(project, session, 'http://localhost:3300/api/data');
        await runMockServiceDecorated('How to separate success and fail pipelines?');

        const metricsPath = path.join(__dirname, 'eval.metrics.json');
        const evalResults = await Eval.evaluateAllFromConfig(metricsPath, units);
        for (const { unit, results } of evalResults) {
            console.log('[eval-results]', JSON.stringify({ tagId: unit.tagId, ts: unit.timestamp, results }));
        }
        endInstrumentSession();
    }
    catch (e) {
        console.error('Error running workflow:', e);
        process.exit(1);
    }
}

main().catch((e) => {
    console.error('Unhandled error:', e);
    process.exit(1);
});
