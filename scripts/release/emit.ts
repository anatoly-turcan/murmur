import { cleanPackage, emitPackage } from './src/emit.ts';

const dir = process.cwd();
if (process.argv.includes('--clean')) {
  console.log(`removed ${cleanPackage(dir)} emitted files in ${dir}`);
} else {
  console.log(`emitted ${emitPackage(dir)} .js files in ${dir}`);
}
