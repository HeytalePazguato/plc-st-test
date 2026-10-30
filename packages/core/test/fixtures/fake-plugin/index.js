// A test-local plugin that contributes one of everything. It must not import workspace packages.
export default {
  apiVersion: 1,
  ingestors: [{ id: 'fake-ingestor', vendor: 'fake', apiVersion: 1, detect: async () => [], load: async () => { throw new Error('not used') } }],
  dialects: [{ id: 'fake-dialect', apiVersion: 1, grammarWasmPath: () => 'fake.wasm', caseSensitive: false, testStrategy: 'method' }],
  simulators: [
    {
      id: 'fake-sim',
      apiVersion: 1,
      attach(s) {
        const log = (globalThis.__fakeSimLog ??= [])
        s.onPreCycle((c) => log.push(`pre${c}`))
        s.onPostCycle((c) => log.push(`post${c}`))
        s.registerHostFn({ name: 'FAKE_FN', minArgs: 0, maxArgs: 0, call: () => undefined })
      },
    },
  ],
  reporters: [{ id: 'fake-reporter', onRunEnd: async () => {} }],
}
