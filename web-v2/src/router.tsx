/** All internal navigation uses the same proven history router. */
export {BrowserRouter as AppRouter, BrowserRouter, MemoryRouter, Link, NavLink, Navigate, Routes, Route, useLocation, useNavigate, useSearchParams, useParams} from 'react-router';
import {matchPath} from 'react-router';
import type {NavigationItem} from './contracts.ts';

export function matchesConsoleRoute(route: NavigationItem, pathname: string) {
  return [route.path, ...route.alternatePaths ?? []].some(path => matchPath(path, pathname) !== null);
}
