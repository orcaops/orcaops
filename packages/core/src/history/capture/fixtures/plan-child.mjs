const configuration = JSON.parse(process.argv[2]);
let handle;
try {
  const { requireDatabaseExecutionContext } = await import(configuration.contextModule);
  const { captureDatabasePlan } = await import(configuration.captureModule);
  const { openProjectDatabase } = await import(configuration.storageModule);
  const context = await requireDatabaseExecutionContext(configuration.repository);
  handle = await openProjectDatabase({ authority: context.authority, mode: 'writer' });
  const start = new Promise((resolve) => process.once('message', resolve));
  process.send?.({ type: 'ready' });
  await start;
  const result = await captureDatabasePlan(handle, context, configuration.input, {
    onWait: (wait) => process.send?.({ type: 'wait', wait }),
  });
  process.send?.({ type: 'result', result });
} catch (cause) {
  process.send?.({ type: 'error', code: cause.code, message: cause.message });
} finally {
  handle?.close();
  process.disconnect();
}
