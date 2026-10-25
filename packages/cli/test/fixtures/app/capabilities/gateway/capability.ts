import { defineCapability } from 'murmur';

import { TodoCreateRequested, TodoListRequested } from '#contracts/todos';

export default defineCapability({
  name: 'gateway',
  ingress: true,
  requests: [TodoCreateRequested, TodoListRequested],
  start: () => ({}),
});
