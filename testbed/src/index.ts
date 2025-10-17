import { endInstrumentSession, startInstrumentSession, Eval, EvalTypes, EvalClient } from '@workspace/instrument';
import { printEvaluationTable } from '@workspace/instrument/dist/eval/evaluator';
import { runMockServiceDecorated } from './workflow';
import { randomUUID } from 'crypto';

async function main() {
    try {
        const project = 'instrumentMeetingInsight';
        const datalake_url = 'http://localhost:3300';
        const units = startInstrumentSession(project, `mock_session_${randomUUID()}`, datalake_url);
        await runMockServiceDecorated('How to separate success and fail pipelines?');
        endInstrumentSession();

        try {
            const client = new EvalClient(datalake_url);
            const remoteResults = await client.evaluate(`${project}:latest`, units);
            printEvaluationTable(remoteResults);
        } catch (err) {
            console.warn('Remote evaluation skipped:', (err as any)?.message || err);
        }

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
