import { closeTestApps } from '../helpers/testApp';

// Runs after every integration test file: open sockets would keep Jest alive.
afterAll(closeTestApps);
