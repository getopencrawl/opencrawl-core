import {createRoot} from 'react-dom/client';
import {OpenCrawlApp} from '../application/app.tsx';
import {createProductApi} from '../application/client.ts';
import {MachineKeysPage} from './machine-keys.tsx';
import '../styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Workspace root is missing');
createRoot(root).render(<OpenCrawlApp api={createProductApi()} extensions={{
  routes: ({data}) => data && data.workspace.role !== 'admin' ? [] : [{
    path: '/settings/machine-keys', label: 'Machine keys', group: 'settings',
    navigation: data?.workspace.role === 'admin', element: <MachineKeysPage key={data?.cacheScope}/>,
  }],
}}/>);
