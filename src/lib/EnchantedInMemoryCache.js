import DefaultGQLStorage from '../GQLStorage';
import { getQueryName } from '../helpers';
import { nestByArrayPath } from '../utils';
import EnchantedPromise from '../helpers/EnchantedPromise';

/**
 * type DocumentNode = {
 *    +kind: 'Document',
 *    +loc?: Location,
 *    +definitions: $ReadOnlyArray<DefinitionNode>,
 * };
 * */
/**
 * @typedef {{
 *  kind: 'Document',
 *  loc?: Location,
 *  definitions: Array<{}>,
 * }} Query - DocumentNode
 * */
/**
 * @typedef {object} QueryObject
 * */
/**
 * @callback Retriever
 * @param {QueryObject} fromQuery
 * @return {object}
 * */
/**
 * @callback Updater
 * @param {QueryObject} fromQuery
 * @param  {QueryObject} updateQuery
 * @return {object}
 * */
/**
 * @typedef {{
 *  data: {}
 *  query: Query
 *  variables
 * }} QueryOptions
 * */
/**
 * @typedef {{
 *  name: string,
 *  queryNode: Query,
 *  updateName: string
 *  updater?: Updater
 * }} LinkedQuery
 * */
/**
 * @typedef {{
 *  name: string,
 *  queryNode: Query,
 *  storeName: string,
 *  nest?: ObjectPath
 *  retrieveField?: string
 *  retriever?: Retriever
 * }} StoredQuery
 * */
/**
 * @typedef {{
 *  name: string,
 *  queryNode: Query,
 *  updateName: string
 *  storeName: string,
 *  nest?: ObjectPath
 *  retrieveField?: string
 *  retriever?: Retriever
 *  updater?: Updater
 * }} SubscribedQuery
 * */
/**
 * @typedef {
 *  Array<SubscribedQuery>
 * } SubscribedQueries
 * */
/**
 * @typedef {InMemoryCache & {
 *  disenchant: Function
 *  restoreAllQueries: Function
 *  writeQuery: Function
 * }} EnchantedInMemoryCache
 * */
/**
 * @typedef {{
 *   subscribedQueries: SubscribedQueries,
 *   version: string | number | any,
 *   migrations?: Array<any>
 * }} EnchantedInMemoryCacheConfig */
/**
 * GeneratedClientQuery - set store defaults as 1st cache write "ROOT_QUERY"
 * @param {InMemoryCache | EnchantedInMemoryCache} aCache
 * @param {EnchantedInMemoryCacheConfig} enchantedInMemoryCacheConfig
 * @param {Boolean?} logCacheWrite
 * @param {GQLStorage?} storage - storage DI
 * @return {EnchantedInMemoryCache}
 * */
// TODO better to extend but seems it's redundant for 1 override & 2 new methods
const createEnchantedInMemoryCache = (
  aCache,
  enchantedInMemoryCacheConfig,
  logCacheWrite,
  storage,
) => {
  // eslint-disable-next-line
  const GQLStorage = storage ? storage : DefaultGQLStorage; // for JSDoc to be handle by WebStorm IDE only

  if (!enchantedInMemoryCacheConfig) {
    throw new Error('No EnchantedInMemoryCacheConfig provided');
  }

  const versionQueryName = '&_cacheVersion_$';
  /** @type EnchantedPromise */
  let versionSyncing;

  const { subscribedQueries, version } = enchantedInMemoryCacheConfig;
  if (version == null) {
    throw new Error('No version of EnchantedInMemoryCacheConfig provided');
  } else {
    versionSyncing = new EnchantedPromise(async (resolve, reject) => {
      try {
        const storedVersion = await GQLStorage.getQuery(versionQueryName);
        if (__DEV__)
          console.log(
            'EnchantedInMemoryCache',
            '\n\tstored version:',
            storedVersion,
            '\n\tcurrent version:',
            version,
          );
        if (storedVersion !== version) {
          // TODO: provide logic of migration
          const queryNames = [];
          subscribedQueries.forEach(handler => {
            if (handler.storeName) {
              queryNames.push(handler.storeName);
            }
          });
          await GQLStorage.multiRemove(queryNames);
          await GQLStorage.saveQuery(versionQueryName, version);
        }
        resolve(true);
      } catch (e) {
        if (__DEV__) {
          console.log('\tVersion Syncing Error:');
          console.warn(e);
        }
        reject(e);
      }
    });
  }

  const restoreFromStorage = async () => {
    const queryNames = [];
    const storedQueries = subscribedQueries.filter(handler => {
      if (handler.storeName) {
        queryNames.push(handler.storeName);
        return true;
      }
      return false;
    });
    const callback = errors => {
      if (__DEV__ && errors) {
        console.log('\tRestore From Storage Error:');
        console.warn(errors);
      }
    };
    const queriesData = await GQLStorage.multiGet(queryNames, callback);
    return storedQueries.map(({ queryNode, nest }, index) =>
      aCache.writeQuery(
        {
          query: queryNode,
          data: nestByArrayPath(nest, queriesData[index]),
        },
        true, // ignore cache update
      ),
    );
  };

  const { write: oldWrite, writeQuery: oldWriteQuery } = aCache;

  /**
   * @method
   * @param {QueryOptions} options
   * @param {Boolean?} ignore
   * */
  const writeQuery = (options, ignore) => {
    aCache.write(
      {
        dataId: 'ROOT_QUERY',
        result: options.data,
        query: aCache.transformDocument(options.query),
        variables: options.variables,
      },
      ignore,
    );
  };

  /**
   * @method
   * @param {{
   *   query: QueryObject
   *   result: Object
   * }} writeData
   * @param {Boolean?} ignore
   * @return void
   * */
  const write = (writeData, ignore) => {
    oldWrite.call(aCache, writeData);
    const { query, result } = writeData;

    const queryName = getQueryName(query);
    if (logCacheWrite && __DEV__) {
      console.info('onCacheWrite', queryName, result, ignore ? 'ignore' : '');
    }
    if (ignore) return;
    // eslint-disable-next-line
    for (let i = 0, max = subscribedQueries.length; i < max; i++) {
      /** @type SubscribedQuery */
      const handler = subscribedQueries[i];
      const {
        name,
        storeName,
        retriever,
        retrieveField,
        updateName,
        updater,
        queryNode,
      } = handler;
      if (queryName === name) {
        if (storeName) {
          /** storing goes asynchronously to do not influence on UI/UX flow */
          (async () => {
            try {
              await GQLStorage.saveQuery(
                storeName,
                retriever ? retriever(result) : result[retrieveField],
              );
            } catch (error) {
              if (__DEV__) {
                console.log('\tStoring Query Error:');
                console.warn(error);
              }
            }
          })();
        } else if (updateName) {
          /** N.B! update cache goes synchronously to be up to date everywhere */
          try {
            const prevValue = aCache.readQuery({ query: queryNode });
            const data = updater
              ? updater(result, prevValue)
              : result[retrieveField];
            aCache.writeQuery({
              query: queryNode,
              data,
            });
          } catch (e) {
            if (__DEV__) {
              console.log('\tUpdating Query Error:');
              console.warn(e);
            }
          }
        }
      }
    }
  };

  /**
   * @method
   * @return void
   * */
  const disenchant = () => {
    aCache.write = oldWrite; // eslint-disable-line
    aCache.writeQuery = oldWriteQuery; // eslint-disable-line
    aCache.disenchant = void 0; // eslint-disable-line
    delete aCache.disenchant; // eslint-disable-line
    aCache.restoreAllQueries = void 0; // eslint-disable-line
    delete aCache.restoreAllQueries; // eslint-disable-line
  };

  /**
   * @method
   * @return Promise
   * */
  const restoreAllQueries = async () => {
    if (versionSyncing.isPending()) {
      await versionSyncing;
      await restoreFromStorage(); // redundant when migration implemented
    } else {
      await restoreFromStorage();
    }
  };

  aCache.write = write; // eslint-disable-line
  aCache.writeQuery = writeQuery; // eslint-disable-line
  aCache.disenchant = disenchant; // eslint-disable-line
  aCache.restoreAllQueries = restoreAllQueries; // eslint-disable-line

  return aCache;
};

export default createEnchantedInMemoryCache;
