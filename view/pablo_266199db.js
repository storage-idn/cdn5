const mysql = require('mysql2/promise');
const fs = require('fs-extra');
const path = require('path');
const moment = require('moment');
const ConfigManager = require('./configManager');

class DatabaseBackup {
    constructor() {
        this.configManager = new ConfigManager();
        this.config = this.configManager.getConfig();
    }

    async ensureBackupDirectory() {
        const backupDir = this.config.backup.backupPath;
        const finalPath = path.isAbsolute(backupDir) ? backupDir : path.join(__dirname, backupDir);
        await fs.ensureDir(finalPath);
        return finalPath;
    }

    async backupSingleDatabase(_, databaseName) {
        const dbConfig = this.config.database;
        const backupDir = await this.ensureBackupDirectory();
        const timestamp = moment().format('YYYY-MM-DD_HH-mm-ss');
        const backupFile = path.join(backupDir, `${databaseName}_${timestamp}.sql`);

        try {
            console.log(`🔄 Starting backup: ${databaseName}`);
            const connection = await mysql.createConnection({
                host: dbConfig.host,
                port: dbConfig.port,
                user: dbConfig.user,
                password: dbConfig.password,
                database: databaseName
            });

            let dump = `-- Database Backup: ${databaseName}\n`;
            dump += `-- Backup Date: ${moment().format('YYYY-MM-DD HH:mm:ss')}\n\n`;

            const [tables] = await connection.execute('SHOW TABLES');
            for (const table of tables) {
                const tableName = table[`Tables_in_${databaseName}`];
                const [createTable] = await connection.execute(`SHOW CREATE TABLE ${tableName}`);
                dump += `\n-- Table: ${tableName}\n`;
                dump += `DROP TABLE IF EXISTS \`${tableName}\`;\n`;
                dump += `${createTable[0]['Create Table']};\n\n`;

                const [rows] = await connection.execute(`SELECT * FROM \`${tableName}\``);
                if (rows.length > 0) {
                    dump += `INSERT INTO \`${tableName}\` VALUES\n`;
                    const values = rows.map(row => {
                        const rowValues = Object.values(row).map(value =>
                            value === null ? 'NULL' :
                            typeof value === 'number' ? value :
                            `'${value.toString().replace(/'/g, "''")}'`
                        );
                        return `(${rowValues.join(', ')})`;
                    });
                    dump += values.join(',\n') + ';\n\n';
                }
            }

            await connection.end();
            await fs.writeFile(backupFile, dump, 'utf8');

            const stats = await fs.stat(backupFile);
            const fileSize = (stats.size / 1024 / 1024).toFixed(2);
            console.log(`✅ Backup saved: ${backupFile} (${fileSize} MB)`);

            return { success: true, file: backupFile, size: fileSize, tables: tables.length };
        } catch (error) {
            console.error(`❌ Backup failed for ${databaseName}:`, error.message);
            return { success: false, error: error.message };
        }
    }

    async cleanupOldBackups() {
        const backupDir = await this.ensureBackupDirectory();
        const keepDays = this.config.backup.keepBackups;
        const files = await fs.readdir(backupDir);
        const sqlFiles = files.filter(f => f.endsWith('.sql'));
        const now = moment();

        let deletedCount = 0;
        for (const file of sqlFiles) {
            const filePath = path.join(backupDir, file);
            const stat = await fs.stat(filePath);
            const daysOld = now.diff(moment(stat.mtime), 'days');
            if (daysOld > keepDays) {
                await fs.remove(filePath);
                console.log(`🗑️ Deleted old backup: ${file}`);
                deletedCount++;
            }
        }
        return deletedCount;
    }
}

module.exports = DatabaseBackup;