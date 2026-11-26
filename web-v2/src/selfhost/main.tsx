import {createRoot} from 'react-dom/client';
import {OpenCrawlApp} from '../application/app.tsx';
import {createProductApi} from '../application/client.ts';
import {ApiKeys} from './api-keys.tsx';
import '../styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Workspace root is missing');
createRoot(root).render(<OpenCrawlApp api={createProductApi()} extensions={{computerApiKeys: <ApiKeys/>}}/>);
