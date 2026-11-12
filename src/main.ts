import { setFailed } from '@actions/core';

import { run } from './app';

run().catch((error: unknown) => {
  setFailed(error instanceof Error ? error.message : String(error));
});
