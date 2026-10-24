// Process entry only. HTTP, security, persistence and business modules live in backend/.
import {startServer} from './backend/application.mjs';
startServer();
