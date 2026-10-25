import { sum } from 'lodash';

import { InvoiceDue } from '../../../contracts/billing.ts';
import { rate } from './rates/rate.ts';

export function total(n: number): number {
  return sum([n * rate, InvoiceDue.name.length]);
}
