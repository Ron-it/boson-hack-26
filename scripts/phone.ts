import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { createPortal } from '../src/mobile/portal.ts';

const usage = `Phone-control probe

  npm run phone -- status
  npm run phone -- open-settings
  npm run phone -- state
  npm run phone -- screenshot
  npm run phone -- tap <x> <y>
  npm run phone -- swipe <start-x> <start-y> <end-x> <end-y>
  npm run phone -- back

Requires Portal accessibility access, its HTTP server, and PORTAL_TOKEN in .env.
For USB development: adb forward tcp:8080 tcp:8080
`;

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined || command === '--help' || command === 'help') {
    console.log(usage);
    return;
  }
  const validCommand = z.enum([
    'status', 'open-settings', 'state', 'screenshot', 'tap', 'swipe', 'back',
  ]).parse(command);
  const expected = validCommand === 'tap' ? 2 : validCommand === 'swipe' ? 4 : 0;
  if (args.length !== expected) {
    throw new Error(`${validCommand} expects ${expected} coordinate arguments`);
  }

  const portal = createPortal();
  const started = performance.now();
  let result: unknown;
  switch (validCommand) {
    case 'status':
      result = await portal.version();
      break;
    case 'open-settings':
      result = await portal.openSettings();
      break;
    case 'state':
      result = await portal.state();
      break;
    case 'back':
      result = await portal.back();
      break;
    case 'tap': {
      const [x, y] = z.tuple([
        z.coerce.number().int().nonnegative(),
        z.coerce.number().int().nonnegative(),
      ]).parse(args);
      result = await portal.tap(x, y);
      break;
    }
    case 'swipe': {
      const coordinate = z.coerce.number().int().nonnegative();
      const [startX, startY, endX, endY] = z.tuple([
        coordinate, coordinate, coordinate, coordinate,
      ]).parse(args);
      result = await portal.swipe(startX, startY, endX, endY);
      break;
    }
    case 'screenshot': {
      const bytes = await portal.screenshot();
      const directory = join(process.cwd(), 'artifacts');
      await mkdir(directory, { recursive: true });
      const filename = join(directory, `phone-${Date.now()}.png`);
      await writeFile(filename, bytes, { flag: 'wx' });
      result = { filename };
      break;
    }
  }
  console.log(JSON.stringify({
    command: validCommand,
    elapsedMs: Math.round(performance.now() - started),
    result,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Phone command failed');
  process.exitCode = 1;
});
