using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.Loader;
using System.Text;

namespace Qomicex.Launcher.Backend.PluginSDK.Core
{
    public class PluginLoadContext : AssemblyLoadContext
    {
        private readonly AssemblyDependencyResolver _resolver;

        public PluginLoadContext(string pluginPath, bool isCollectible = true)
            : base(Path.GetFileNameWithoutExtension(pluginPath), isCollectible)
        {
            _resolver = new AssemblyDependencyResolver(pluginPath);
        }

        protected override Assembly? Load(AssemblyName assemblyName)
        {
            var assemblyPath = _resolver.ResolveAssemblyToPath(assemblyName);
            return assemblyPath != null
                ? LoadFromAssemblyPath(assemblyPath)
                : null;
        }
    }
}
