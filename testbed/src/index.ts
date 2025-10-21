import { endInstrumentSession, startInstrumentSession, Eval, EvalTypes, EvalClient, setInstrumentSessionReplay } from '@workspace/instrument';
import { printEvaluationTable } from '@workspace/instrument/dist/eval/evaluator';
import { runMockServiceDecorated } from './workflow';
import { randomUUID } from 'crypto';

function parseSessionIdArg(): string | undefined {
    const argv = process.argv.slice(2);
    let nextAfterFlag: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--session' || a === '--sessionId') {
            nextAfterFlag = argv[i + 1];
            // Do not return immediately; validate it's not another flag or undefined
            break;
        }
        const m = a.match(/^--session(Id)?=(.+)$/);
        if (m) return m[2];
    }
    if (nextAfterFlag !== undefined && !nextAfterFlag.startsWith('--')) {
        return nextAfterFlag;
    }
    // Fallbacks for npm run variable forwarding and env overrides
    // npm run dev:testbed --session=abc sets npm_config_session=abc
    const envSession = process.env.npm_config_session || process.env.npm_config_sessionid;
    if (envSession && envSession !== 'true') return envSession;
    const directEnv = process.env.SESSION_ID || process.env.INSTRUMENT_SESSION;
    if (directEnv) return directEnv;
    // Positional: if user passed a lone value after script (e.g. npm run dev:testbed mySession)
    const firstPositional = argv.find((a) => !a.startsWith('--'));
    if (firstPositional) return firstPositional;
    return undefined;
}

async function main() {
    try {
        const project = 'instrumentMeetingInsight';
        const datalake_url = 'http://localhost:3300';
        const provided = parseSessionIdArg();
        const sessionId = provided ? provided : `mock_session_${randomUUID()}`;
        const units = await startInstrumentSession(project, sessionId, datalake_url, true);
        console.log('[session]', sessionId);
        const result = await runMockServiceDecorated('How to separate success and fail pipelines?');
        console.log(`[result] ${JSON.stringify(result, null, 2)}`);
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
