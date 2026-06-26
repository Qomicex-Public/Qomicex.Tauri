using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Qomicex.Launcher.Backend.Modules.Helpers.Resources.Expansion.CurseForge
{
    public class Modpacks : CurseForgeBase
    {
        public Modpacks(string ApiKey) : base(ApiKey, GetSearchUrl(), GetModUrl()) { }
        private static string GetSearchUrl()
        {
            return "/v1/mods/search?gameId=432&classId=4471";
        }

        private static string GetModUrl()
        {
            return "/v1/mods/";
        }

        /// <summary>
        /// 获取推荐的Modpack列表
        /// </summary>
        /// <param name="GameVersions">游戏版本</param>
        /// <param name="Categories">分类</param>
        /// <param name="ModLoaderTypes">模组加载器</param>
        /// <param name="SortField">排序方式</param>
        /// <param name="Page">页数</param>
        /// <param name="PageSize">页面大小</param>
        /// <returns>结果</returns>
        public async Task<List<CurseForgeSearchResult>> GetRecommendModpacks(string?[] GameVersions, int?[] Categories, string[]? ModLoaderTypes, int? SortField = 0, int? Page = 1, int? PageSize = 25)
        {
            return await base.GetRecommend(GameVersions, Categories, ModLoaderTypes, SortField, Page, PageSize);
        }

        /// <summary>
        /// 异步搜索CurseForge上的Modpack
        /// </summary>
        /// <param name="SearchFilter">搜索关键词</param>
        /// <param name="SortField">排序方式</param>
        /// <param name="GameVersions">游戏版本</param>
        /// <param name="Categories">分类标签</param>
        /// <param name="ModLoaderTypes">ModLoader类型</param>
        /// <param name="Page">页数</param>
        /// <param name="PageSize">单页搜索结果条目数</param>
        /// <returns></returns>
        /// <exception cref="ArgumentOutOfRangeException"></exception>
        /// <exception cref="Exception"></exception>
        public new async Task<List<CurseForgeSearchResult>> SearchAsync(string SearchFilter, string?[] GameVersions, int?[] Categories, string[]? ModLoaderTypes, int? SortField = 0, int? Page = 1, int? PageSize = 25)
        {
            return await base.SearchAsync(SearchFilter, GameVersions, Categories, ModLoaderTypes, SortField, Page, PageSize);
        }

        /// <summary>
        /// 异步获取指定Modpack的详细信息
        /// </summary>
        /// <param name="ModpackId">ModId</param>
        /// <returns>Mod信息</returns>
        /// <exception cref="ArgumentNullException"></exception>
        /// <exception cref="Exception"></exception>
        public async Task<CurseForgeInfo> GetModInfoAsync(string ModpackId)
        {
            return await base.GetInfoAsync(ModpackId);
        }

        public enum Category
        {
            AdventureAndRpg = 4475,
            FtbOfficialPack = 4487,
            Quests = 4478,
            SmallOrLight = 4481,
            CombatOrPvp = 4483,
            Tech = 4472,
            Sci_fi = 4474,
            Hardcore = 4479,
            Multiplayer = 4484,
            MiniGame = 4477,
            ExtraLarge = 4482,
            Magic = 4473,
            Skyblock = 4736,
            MapBased = 4480,
            Exploration = 4476,
            VanillaAdd = 5128,//这里的Add是+
            Horror = 7418,
        }

    }
}
