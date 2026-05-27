import dbJson from '@db';
import type { NodeDB } from '../../server/db-types';
export const DB: NodeDB = dbJson as NodeDB;
