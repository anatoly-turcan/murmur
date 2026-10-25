import blankLineAroundBlocks from './rules/blank-line-around-blocks.ts';
import contractFactoryWrapped from './rules/contract-factory-wrapped.ts';
import contractsJsonFaithful from './rules/contracts-json-faithful.ts';
import coreNoNode from './rules/core-no-node.ts';
import declaredDepsOnly from './rules/declared-deps-only.ts';
import decoratorArgsStatic from './rules/decorator-args-static.ts';
import decoratorsInPiecesOnly from './rules/decorators-in-pieces-only.ts';
import emitDeclared from './rules/emit-declared.ts';
import erasableSyntaxOnly from './rules/erasable-syntax-only.ts';
import folderLocalImports from './rules/folder-local-imports.ts';
import groupFolderFiles from './rules/group-folder-files.ts';
import internalContractsScope from './rules/internal-contracts-scope.ts';
import libPure from './rules/lib-pure.ts';
import methodReturnType from './rules/method-return-type.ts';
import modelNoRuntime from './rules/model-no-runtime.ts';
import noCommentsInFunctions from './rules/no-comments-in-functions.ts';
import noCrossPieceContractsImport from './rules/no-cross-piece-contracts-import.ts';
import noNestedTernary from './rules/no-nested-ternary.ts';
import noProcessEnv from './rules/no-process-env.ts';
import noTypeofTypes from './rules/no-typeof-types.ts';
import onePiecePerFolder from './rules/one-piece-per-folder.ts';
import pieceExportsOneClass from './rules/piece-exports-one-class.ts';
import toolingNoRuntime from './rules/tooling-no-runtime.ts';
import type { Rule } from './types.ts';

const rules: Record<string, Rule> = {
  'folder-local-imports': folderLocalImports,
  'declared-deps-only': declaredDepsOnly,
  'piece-exports-one-class': pieceExportsOneClass,
  'one-piece-per-folder': onePiecePerFolder,
  'decorators-in-pieces-only': decoratorsInPiecesOnly,
  'decorator-args-static': decoratorArgsStatic,
  'contract-factory-wrapped': contractFactoryWrapped,
  'no-process-env': noProcessEnv,
  'no-comments-in-functions': noCommentsInFunctions,
  'no-typeof-types': noTypeofTypes,
  'no-nested-ternary': noNestedTernary,
  'blank-line-around-blocks': blankLineAroundBlocks,
  'method-return-type': methodReturnType,
  'emit-declared': emitDeclared,
  'no-cross-piece-contracts-import': noCrossPieceContractsImport,
  'internal-contracts-scope': internalContractsScope,
  'group-folder-files': groupFolderFiles,
  'contracts-json-faithful': contractsJsonFaithful,
  'erasable-syntax-only': erasableSyntaxOnly,
  'core-no-node': coreNoNode,
  'model-no-runtime': modelNoRuntime,
  'tooling-no-runtime': toolingNoRuntime,
  'lib-pure': libPure,
};

export default {
  meta: { name: 'murmur' },
  rules,
};
