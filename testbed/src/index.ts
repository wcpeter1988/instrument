import { endInstrumentSession, startInstrumentSession } from '@workspace/instrument';
import { runMockServiceDecorated } from './workflow';
import { randomUUID } from 'crypto';

async function main() {
    try {
        const sessionId = randomUUID();
        startInstrumentSession('instrumentMeetingInsight', `meeting_insight_${sessionId}`, 'http://localhost:3300/api/data');
        const result2: unknown = await runMockServiceDecorated('How to separate success and fail pipelines?');
        endInstrumentSession();
        console.log('Workflow result:', result2);
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
