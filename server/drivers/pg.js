const fs = require('fs')
const pg = require('pg')
const PgCursor = require('pg-cursor')
const SocksConnection = require('socksjs')

function createSocksConnection(connection) {
  if (connection.useSocks) {
    return new SocksConnection(
      {
        host: connection.host,
        port: connection.port
      },
      {
        host: connection.socksHost,
        port: connection.socksPort,
        user: connection.socksUsername,
        pass: connection.socksPassword
      }
    )
  }
}

const SCHEMA_SQL = `
  select 
    ns.nspname as table_schema, 
    cls.relname as table_name, 
    attr.attname as column_name,
    trim(leading '_' from tp.typname) as data_type
  from 
    pg_catalog.pg_attribute as attr
    join pg_catalog.pg_class as cls on cls.oid = attr.attrelid
    join pg_catalog.pg_namespace as ns on ns.oid = cls.relnamespace
    join pg_catalog.pg_type as tp on tp.typelem = attr.atttypid
  where 
    cls.relkind in ('r', 'v', 'm')
    and ns.nspname not in ('pg_catalog', 'pg_toast', 'information_schema')
    and not attr.attisdropped 
    and attr.attnum > 0
  order by 
    ns.nspname,
    cls.relname,
    attr.attnum
`

function runQuery(query, connection, queryResult) {
  const pgConfig = {
    user: connection.username,
    password: connection.password,
    database: connection.database,
    host: connection.host,
    ssl: connection.postgresSsl,
    stream: createSocksConnection(connection)
  }
  // TODO cache key/cert values
  if (connection.postgresKey && connection.postgresCert) {
    pgConfig.ssl = {
      key: fs.readFileSync(connection.postgresKey),
      cert: fs.readFileSync(connection.postgresCert)
    }
    if (connection.postgresCA) {
      pgConfig.ssl['ca'] = fs.readFileSync(connection.postgresCA)
    }
  }
  if (connection.port) pgConfig.port = connection.port

  return new Promise((resolve, reject) => {
    const client = new pg.Client(pgConfig)
    client.connect(err => {
      if (err) {
        client.end()
        return reject(err)
      }
      const cursor = client.query(new PgCursor(query))
      cursor.read(connection.maxRows + 1, (err, rows) => {
        if (err) {
          // pg_cursor can't handle multi-statements at the moment
          // as a work around we'll retry the query the old way, but we lose the maxRows protection
          client.query(query, (err, result) => {
            client.end()
            if (err) {
              return reject(err)
            }
            if (result && result.rows) {
              queryResult.addRows(result.rows)
            }
            return resolve(queryResult)
          })
        } else {
          queryResult.addRows(rows)
          if (rows.length === connection.maxRows + 1) {
            queryResult.incomplete = true
            queryResult.rows.pop() // get rid of that extra record. we only get 1 more than the max to see if there would have been more...
          }
          if (err) {
            reject(err)
          } else {
            resolve(queryResult)
          }
          cursor.close(err => {
            if (err) {
              console.log('error closing pg-cursor:')
              console.log(err)
            }
            client.end()
          })
        }
      })
    })
  })
}

module.exports = {
  runQuery,
  SCHEMA_SQL
}
