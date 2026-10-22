function command(name: string, ...parameters: Record<string, unknown>[]) {
  return {
    type: 'object',
    properties: {
      run: {
        type: 'array',
        prefixItems: [{ const: name }, ...parameters],
        minItems: parameters.length + 1,
        maxItems: parameters.length + 1,
      },
    },
    required: ['run'],
    additionalProperties: false,
  };
}

const filename = { type: 'string', minLength: 1 };

export const actionSchema = {
  anyOf: [
    command('list'),
    command('read', filename),
    command('write', filename, { type: 'string' }),
    command('test'),
    {
      type: 'object',
      properties: {
        done: { const: true },
        summary: { type: 'string', minLength: 1 },
      },
      required: ['done', 'summary'],
      additionalProperties: false,
    },
  ],
};
