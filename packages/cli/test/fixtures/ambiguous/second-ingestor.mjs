// The generic ingestor alone never offers two candidates, so this second one ties with its confidence to make the project ambiguous.
export default {
  apiVersion: 1,
  ingestors: [
    {
      id: 'second',
      vendor: 'second',
      apiVersion: 1,
      detect: async () => [{ ingestorId: 'second', projectFile: 'second.proj', label: 'Second project', confidence: 0.3 }],
      load: async () => {
        throw new Error('never loaded')
      },
    },
  ],
}
