import {main} from '../runtime/source-film/source-film.mjs';
main().catch(e=>{console.error(e.stack??e.message);process.exitCode=1;});
