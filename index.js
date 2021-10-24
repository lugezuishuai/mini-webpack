const fs = require('fs');
const path = require('path');
const babelParser = require('@babel/parser'); // babel解析器（生成ast）
const traverse = require('@babel/traverse').default; // 递归解析所有的import模块
const { transformFromAst } = require('@babel/core');
const config = require('./mini-webpack.config'); // 获取配置文件
const entry = config.entry; // 入口
const output = config.output; // 出口

/**
 * 解析文件内容极其依赖
 * @param {string} filename 文件路径
 */
function createAsset(filename) {
  const content = fs.readFileSync(filename, 'utf-8');
  // 使用 @babel/parser 解析代码，生成ast
  const ast = babelParser.parse(content, {
    sourceType: 'module' // es module
  });

  // 从ast中获取所有的依赖模块(import)，并放入dependencies中
  const dependencies = [];
  traverse(ast, {
    // 遍历所有的import模块，并将相对路径放入dependencies
    ImportDeclaration: ({ node }) => {
      dependencies.push(node.source.value);
    }
  });

  // 获取文件内容
  const { code } = transformFromAst(ast, null, { presets: ['@babel/preset-env'] });
  return {
    dependencies,
    code,
  };
}

/**
 * 从入口文件开始，获取整个依赖图
 * @param {string} entry 入口文件
 */
function createGraph(entry) {
  // 从入口文件开始，解析每一个依赖资源，并将其一次性放入队列中
  if (!entry.includes(__dirname)) {
    // 相对路径
    entry = path.join(__dirname, entry);
  }
  const mainAssert = createAsset(entry)
  const queue = {
    [entry]: mainAssert
  }

  /**
   * 递归遍历，获取所有的依赖
   * @param {string} filename 绝对路劲
   * @param {*} assert 入口文件
   */
  function recursionDep(filename, assert) {
    // 跟踪所有的依赖文件（模块唯一的标识符）
    assert.mapping = {};
    // 由于所有依赖模块的import路径为相对路径，所以获取当前绝对路径
    assert.dependencies.forEach(relativePath => {
      // 获取绝对路径，以便于createAsset读取文件
      const dirname = path.dirname(filename); // 当前目录所在的路径
      const absolutePath = path.join(dirname, relativePath);
      // 与当前的assert关联
      assert.mapping[relativePath] = absolutePath;
      // 依赖文件没有加入到依赖图中，才让其加入，避免模块重复打包
      if (!queue[absolutePath]) {
        // 获取依赖模块内容
        const child = createAsset(absolutePath);
        // 将依赖放入 queue，以便于 for 继续解析依赖资源的依赖，直到所有依赖解析完成，这就构成了一个从入口文件开始的依赖图
        queue[absolutePath] = child;
        if (child.dependencies.length > 0) {
          // 继续递归
          recursionDep(absolutePath, child);
        }
      }
    });
  }

  recursionDep(entry, queue[entry]);
  console.log('queue', queue);

  // 返回依赖图
  return queue;
}

/**
 * 打包（使用依赖图，返回一个可以在浏览器运行的包）
 * 所以返回一个立即执行函数 (function() {})()
 * 这个函数只接收一个参数，包含依赖图中所有信息
 * 
 * 遍历 graph，将每个 mod 以 `key: value,` 的方式加入到 modules，
 * 其中key 为 filename, 模块的唯一标识符，value 为一个数组， 它包含：
 * function(require, module, exports){${mod.code}}
 * ${JSON.stringify(mod.mapping)}
 * 
 * 其中：function(require, module, exports){${mod.code}}
 * 使用函数包装每一个模块的代码 mode.code，防止 mode.code 污染全局变量或其它模块
 * 并且模块转化后运行在 common.js 系统，它们期望有 require, module, exports 可用
 * 
 * 其中：${JSON.stringify(mod.mapping)} 是模块间的依赖关系，当依赖被 require 时调用
 * 例如：{ './message.js': 1 }
 * 
 * @param {object} graph 依赖图
 */
function bundle(graph) {
  let modules = ''
  for (const filename in graph) {
    const mod = graph[filename]
    modules += `'${filename}': [
      function(require, module, exports) {
        ${mod.code}
      },
      ${JSON.stringify(mod.mapping)},
    ],`
  }

  console.log('modules', modules);


  // 注意：modules 是一组 `key: value,`，所以我们将它放入 {} 中
  // 实现 立即执行函数
  // 首先实现一个 require 函数，require('${entry}') 执行入口文件，entry 为入口文件绝对路径，也为模块唯一标识符
  // require 函数接受一个 id（filename 绝对路径） 并在其中查找它模块我们之前构建的对象. 
  // 通过解构 const [fn, mapping] = modules[id] 来获得我们的函数包装器和 mappings 对象.
  // 由于一般情况下 require 都是 require 相对路径，而不是id（filename 绝对路径），所以 fn 函数需要将 require 相对路径转换成 require 绝对路径，即 localRequire
  // 注意：不同的模块 id（filename 绝对路径）时唯一的，但相对路径可能存在相同的情况
  // 
  // 将 module.exports 传入到 fn 中，将依赖模块内容暴露处理，当 require 某一依赖模块时，就可以直接通过 module.exports 将结果返回
  const result = `
    (function(modules) {
      function require(moduleId) {
        const [fn, mapping] = modules[moduleId]
        function localRequire(name) {
          return require(mapping[name])
        }
        const module = {exports: {}}
        fn(localRequire, module, module.exports)
        return module.exports
      }
      require('${entry.includes(__dirname) ? entry : path.join(__dirname, entry)}')
    })({${modules}})
  `;

  console.log('result', result);
  return result
}

/**
 * 输出打包
 * @param {string} path 路径
 * @param {string} result 内容
 */
 function writeFile(path, result) {
  // 写入 ./dist/bundle.js
  fs.writeFile(path, result, (err) => {
    if (err) throw err;
    console.log('文件已被保存');
  });
}

// 获取依赖图
const graph = createGraph(entry);
// 打包
const result = bundle(graph);
// 输出
fs.access(`${output.path}/${output.filename}`, (err) => {
  if(!err) {
    writeFile(`${output.path}/${output.filename}`, result)
  } else {
    fs.mkdir(output.path, { recursive: true }, (err) => {
      if (err) throw err;
      writeFile(`${output.path}/${output.filename}`, result)
    });
  }
});